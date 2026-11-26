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

/** Ghi khoản hoàn tiền và dòng chi; bên gọi tự đồng bộ trạng thái và ghi sự kiện. */
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

/** Tiền shop đang giữ của đơn. */
export function depositHeld(
  payments: readonly Pick<DepositPaymentRow, 'kind' | 'status' | 'amount'>[],
): number {
  return paymentTotals(payments).net;
}

/** Các khoản đã thu còn hoàn được khi huỷ. */
const REFUNDABLE_KINDS: readonly string[] = [
  PaymentKind.DEPOSIT,
  PaymentKind.BALANCE,
  PaymentKind.FULL,
];

/** Số hoàn khi huỷ do người huỷ chọn, từ 0 tới toàn bộ số đang giữ. */
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

/** Trần một lần hoàn: toàn bộ tiền đang giữ hoặc phần khách trả dư. */
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

/** Hoàn tiền cho khách ngoài huỷ đơn; bên gọi đã khoá đơn. */
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

/** Gợi ý số hoàn khi kiểm hàng trả: giá trị hàng hoàn, không vượt số đang giữ. */
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
