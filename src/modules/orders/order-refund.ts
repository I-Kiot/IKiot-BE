import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';
import { writePaymentCashFlow } from './order-cash-flow';
import { toDong } from '../../common/utils/money';
import type { AuthUser } from '../../common/types/auth-user.type';
import { OrderEventType } from '../../common/constants/order-event-type';
import {
  recordOrderEvent,
  userActor,
  type OrderEventMetadata,
} from './order-events';
import {
  derivePaymentStatus,
  paymentRowsOf,
  paymentTotals,
  syncOrderPaymentStatus,
  type DerivedPayment,
} from './payment-status';

/**
 * Tiền trả lại khách: khoản `REFUND` (PAID, trỏ về khoản đã nhận) + dòng chi `ORDER_REFUND` có `orderId` và `paymentId`. Một nơi cho huỷ đơn hành trình, huỷ đơn quầy có tiền và trả hàng đơn quầy.
 * KHÔNG gọi `syncOrderPaymentStatus` và không ghi sự kiện: người gọi còn việc khác trong cùng transaction (chiếm đơn, trả kho) và sync một lần ở cuối, rồi ghi sự kiện của riêng nó (CANCELLED / STATUS_CHANGED).
 * Người gọi đã khoá đơn và đã kiểm số hoàn không vượt số tiền đang giữ (`resolveRefund`).
 */
export async function recordRefundPayment(
  tx: Prisma.TransactionClient,
  input: {
    order: { id: string; tenantId: string; code: string; branchId: string };
    amount: number;
    method: string;
    refundOfPaymentId: string;
    actorId: string | null;
    note: string | null;
    description: string;
    now: Date;
  },
): Promise<{ id: string }> {
  const { order, now } = input;
  const payment = await tx.payment.create({
    data: {
      tenantId: order.tenantId,
      orderId: order.id,
      kind: PaymentKind.REFUND,
      method: input.method,
      amount: input.amount,
      status: PaymentRecordStatus.PAID,
      paidAt: now,
      refundOfPaymentId: input.refundOfPaymentId,
      locationId: order.branchId,
      createdById: input.actorId,
      note: input.note,
    },
    select: { id: true, amount: true, method: true },
  });
  await writePaymentCashFlow(tx, {
    tenantId: order.tenantId,
    payment,
    category: CashFlowCategory.ORDER_REFUND,
    orderId: order.id,
    orderCode: order.code,
    locationId: order.branchId,
    createdById: input.actorId,
    description: input.description,
  });
  return { id: payment.id };
}

export interface DepositPaymentRow {
  id: string;
  kind: string;
  status: string;
  method: string;
  amount: number;
  createdAt: Date;
}

export interface ResolvedRefund {
  held: number;
  amount: number;
  method: string;
  refundOfPaymentId: string;
}

/** Tiền shop đang giữ của đơn (thu trừ hoàn trừ thối): `paymentTotals(...).net`, cùng một số với `resolveRefund` và trạng thái thanh toán. Dùng khi sửa đơn (A-8) để so với cọc. */
export function depositHeld(
  payments: readonly Pick<DepositPaymentRow, 'kind' | 'status' | 'amount'>[],
): number {
  return paymentTotals(payments).net;
}

/** Khoản shop đã thu của đơn còn huỷ được: cọc, số còn lại nếu là đơn khách tới lấy đã thu tại quầy, và khoản trả đủ một lần. Đơn giao tận nơi chỉ có BALANCE sau khi giao, lúc đó đã không huỷ được nữa. */
const REFUNDABLE_KINDS: readonly string[] = [
  PaymentKind.DEPOSIT,
  PaymentKind.BALANCE,
  PaymentKind.FULL,
];

/**
 * Hoàn tiền khi huỷ (A-5): người huỷ tự chọn số tiền hoàn, từ 0 (shop giữ lại) tới toàn bộ số đang giữ. Không có mặc định vì mặc định nào cũng là chuyển tiền của khách mà chưa hỏi. Null khi không có gì để hoàn và không giữ gì.
 */
export function resolveRefund(
  payments: readonly DepositPaymentRow[],
  refundAmount: number | undefined,
  refundMethod: string | undefined,
): ResolvedRefund | null {
  const received = payments
    .filter(
      (p) =>
        p.status === PaymentRecordStatus.PAID &&
        REFUNDABLE_KINDS.includes(p.kind),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // Số đang giữ là `net` của quy tắc chung (thu trừ hoàn trừ thối), không tự cộng trừ lại ở đây.
  const held = paymentTotals(payments).net;

  if (held <= 0) {
    if (refundAmount) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
        message: 'This order holds no money to refund',
      });
    }
    return null;
  }
  if (refundAmount === undefined) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED,
      message: `The order holds ${held}; say how much of it is refunded (0 keeps it)`,
    });
  }
  const amount = Math.round(refundAmount);
  if (amount > held) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
      message: `A refund of ${amount} exceeds the money held (${held})`,
    });
  }
  const [latest] = received;
  return {
    held,
    amount,
    // SePay chỉ báo tiền vào, không chuyển tiền ra: khoản thu qua QR được hoàn bằng chuyển khoản.
    method:
      refundMethod ??
      (latest.method === PaymentMethod.SEPAY
        ? PaymentMethod.BANK_TRANSFER
        : latest.method),
    refundOfPaymentId: latest.id,
  };
}

/** Trần của một lần hoàn: toàn bộ tiền đang giữ (trả hàng), hoặc chỉ phần khách trả dư so với tổng đơn (`refund-excess`). */
export type RefundCap = 'HELD' | 'EXCESS';

export interface RecordRefundInput {
  order: { id: string; tenantId: string; code: string; branchId: string };
  amount: number;
  method: string;
  cap: RefundCap;
  actor: AuthUser;
  /** Lý do ghi vào sự kiện REFUNDED (không phải lý do trả hàng của khách). */
  reason: string;
  note: string | null;
  /** Mô tả dòng chi trong sổ thu chi. */
  description: string;
  now: Date;
  /** Liên kết thêm vào metadata của sự kiện (phiếu hoàn...). */
  metadata?: OrderEventMetadata;
}

/**
 * Hoàn tiền cho khách ngoài huỷ đơn (Phase 6): lúc kiểm hàng trả, trả hàng đơn quầy, hoàn phần khách trả dư. Người gọi ĐÃ khoá đơn (`lockOrder`).
 * Trong transaction của người gọi: đọc lại các khoản và tính trần từ `derivePaymentStatus` → khoản `REFUND` PAID trỏ về khoản đã nhận gần nhất + dòng chi `ORDER_REFUND` (địa điểm = chi nhánh của đơn, quyết định D5)
 * → `syncOrderPaymentStatus` → sự kiện `REFUNDED` do người gọi (người bấm) đứng tên. Vượt trần là 400 `ORDER_REFUND_EXCEEDS_PAID`, không ghi gì.
 */
export async function recordRefund(
  tx: Prisma.TransactionClient,
  input: RecordRefundInput,
): Promise<{ paymentId: string; derived: DerivedPayment }> {
  const { order } = input;
  const amount = toDong(input.amount);
  const row = await tx.order.findUniqueOrThrow({
    where: { id: order.id },
    select: {
      grandTotal: true,
      depositAmount: true,
      payments: {
        select: {
          id: true,
          kind: true,
          status: true,
          method: true,
          amount: true,
          createdAt: true,
        },
      },
    },
  });
  const before = derivePaymentStatus(row.grandTotal, paymentRowsOf(row));
  const max = input.cap === 'EXCESS' ? before.overpaidBy : before.net;
  const origin = row.payments
    .filter(
      (p) =>
        p.status === PaymentRecordStatus.PAID &&
        REFUNDABLE_KINDS.includes(p.kind),
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (amount <= 0 || amount > max || !origin) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID,
      message:
        input.cap === 'EXCESS'
          ? `A refund of ${amount} exceeds the overpayment (${before.overpaidBy})`
          : `A refund of ${amount} exceeds the money held (${before.net})`,
      max,
      held: before.net,
    });
  }

  const payment = await recordRefundPayment(tx, {
    order,
    amount,
    method: input.method,
    refundOfPaymentId: origin.id,
    actorId: input.actor.userId,
    note: input.note,
    description: input.description,
    now: input.now,
  });
  const derived = await syncOrderPaymentStatus(tx, order.id);
  await recordOrderEvent(tx, userActor(input.actor), {
    tenantId: order.tenantId,
    orderId: order.id,
    type: OrderEventType.REFUNDED,
    metadata: {
      ...input.metadata,
      amount,
      method: input.method,
      paymentId: payment.id,
      reason: input.reason,
      note: input.note,
    },
  });
  return { paymentId: payment.id, derived };
}

/** Gợi ý số hoàn khi kiểm hàng trả: giá trị hàng của các dòng hoàn (đã trừ giảm giá), bị chặn bởi số tiền đang giữ. Phí giao chỉ được hoàn khi người kiểm tự nhập số lớn hơn. */
export function refundSuggestionOf(input: {
  held: number;
  goodsValue: number;
  shippingFee: number;
  received: number;
  refunded: number;
}) {
  return {
    suggested: Math.max(0, Math.min(input.held, input.goodsValue)),
    max: Math.max(0, input.held),
    goodsValue: input.goodsValue,
    shippingFee: input.shippingFee,
    received: input.received,
    refunded: input.refunded,
  };
}
