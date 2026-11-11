import type { Prisma } from '../../../generated/prisma/client';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { toDong } from '../../common/utils/money';
import { writePaymentCashFlow } from './order-cash-flow';
import { newQrExpiresAt } from './sepay-qr';
import { syncOrderPaymentStatus } from './payment-status';

// Dòng Payment của đơn quầy (Phase 3, 2026-11-11). Trước đây đơn quầy không có Payment: quầy tự ghi dòng thu chi (và dòng tiền thối không gắn đơn), trạng thái thanh toán đặt tay,
// nên sổ của đơn quầy và đơn hành trình đi hai đường khác nhau. Từ nay một lần bán ở quầy là: FULL (+ CHANGE nếu thối tiền) với phương thức nhận ngay, hay FULL SEPAY PENDING chờ webhook.

type PosOrder = {
  id: string;
  tenantId: string;
  code: string;
  branchId: string;
  grandTotal: Prisma.Decimal | number;
  paymentReference: string | null;
};

/**
 * Ghi tiền nhận ngay của một lần bán / chốt đơn quầy: khoản vào (`FULL`, hay `BALANCE` khi đơn đã có tiền trước đó) + dòng thu chi `ORDER_PAYMENT`; tiền mặt thối thì thêm khoản `CHANGE`
 * (trỏ về khoản vào, tiền ra) + dòng chi `SALE_CHANGE` có `orderId` và `paymentId` (quyết định 7: dòng thối gắn đơn). Cuối cùng `syncOrderPaymentStatus`: tiền giữ = tiền vào − thối = số phải trả, nên đơn ra PAID.
 *
 * `amountDue` là số còn phải thu (tổng đơn khi chưa có gì; phần còn lại khi đã trả một phần). `customerPay` là số khách đưa, chỉ có nghĩa với tiền mặt: các phương thức khác chỉ nhận đúng số phải thu (tiền thối chỉ có ở tiền mặt).
 * Người gọi đã khoá đơn và kiểm `customerPay ≥ amountDue`.
 */
export async function recordPosPayments(
  tx: Prisma.TransactionClient,
  input: {
    order: PosOrder;
    method: string;
    amountDue: number;
    customerPay: number | null;
    kind: typeof PaymentKind.FULL | typeof PaymentKind.BALANCE;
    actorId: string | null;
    now: Date;
  },
): Promise<{
  paymentId: string | null;
  change: number;
  changePaymentId: string | null;
}> {
  const { order, method, amountDue, kind, actorId, now } = input;
  const change =
    method === PaymentMethod.CASH && input.customerPay !== null
      ? Math.max(0, toDong(input.customerPay) - amountDue)
      : 0;
  const received = amountDue + change;
  // Đơn giảm giá về 0đ: không có đồng nào đổi chủ nên không có khoản nào (Payment.amount phải dương). Trạng thái thanh toán vẫn suy ra: tiền giữ 0 ≥ tổng đơn 0 là PAID.
  if (received <= 0) {
    await syncOrderPaymentStatus(tx, order.id);
    return { paymentId: null, change: 0, changePaymentId: null };
  }

  const full = await tx.payment.create({
    data: {
      tenantId: order.tenantId,
      orderId: order.id,
      kind,
      method,
      amount: received,
      status: PaymentRecordStatus.PAID,
      paidAt: now,
      locationId: order.branchId,
      collectedById: actorId,
      createdById: actorId,
    },
    select: { id: true, amount: true, method: true },
  });
  await writePaymentCashFlow(tx, {
    tenantId: order.tenantId,
    payment: full,
    category: CashFlowCategory.ORDER_PAYMENT,
    orderId: order.id,
    orderCode: order.code,
    locationId: order.branchId,
    createdById: actorId,
    description: `Đơn hàng ${order.code}`,
  });

  let changePaymentId: string | null = null;
  if (change > 0) {
    const changePayment = await tx.payment.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        kind: PaymentKind.CHANGE,
        method: PaymentMethod.CASH,
        amount: change,
        status: PaymentRecordStatus.PAID,
        paidAt: now,
        refundOfPaymentId: full.id,
        locationId: order.branchId,
        createdById: actorId,
      },
      select: { id: true, amount: true, method: true },
    });
    await writePaymentCashFlow(tx, {
      tenantId: order.tenantId,
      payment: changePayment,
      category: CashFlowCategory.SALE_CHANGE,
      orderId: order.id,
      orderCode: order.code,
      locationId: order.branchId,
      createdById: actorId,
      description: `Tiền thối cho đơn ${order.code}`,
    });
    changePaymentId = changePayment.id;
  }

  await syncOrderPaymentStatus(tx, order.id);
  return { paymentId: full.id, change, changePaymentId };
}

/**
 * Khoản QR SePay chờ tiền của đơn quầy: `FULL` khi lần bán mở ở PENDING, `BALANCE` khi phát mã cho phần còn lại (`POST /orders/pos/:id/qr`). Số tiền mã yêu cầu ghi ở `requestedAmount`; `amount` là số tiền thực về nên ban đầu bằng nó.
 * `reference` là nội dung chuyển khoản (mã ORD): lần đầu cũng là mã đơn, các lần sau là mã mới (`payments.payment_reference` unique trong bảng của nó).
 */
export function openPosQrPayment(
  tx: Prisma.TransactionClient,
  input: {
    order: Pick<PosOrder, 'id' | 'tenantId' | 'branchId'>;
    kind: typeof PaymentKind.FULL | typeof PaymentKind.BALANCE;
    amount: number;
    reference: string;
    /** Mốc tính hạn mã: lúc tạo đơn cho lần bán đầu (FE đếm ngược theo `qrExpiresAt` của đơn), lúc phát cho các mã sau. */
    issuedAt: Date;
    actorId: string | null;
  },
) {
  return tx.payment.create({
    data: {
      tenantId: input.order.tenantId,
      orderId: input.order.id,
      kind: input.kind,
      method: PaymentMethod.SEPAY,
      amount: input.amount,
      requestedAmount: input.amount,
      status: PaymentRecordStatus.PENDING,
      paymentReference: input.reference,
      expiresAt: newQrExpiresAt(input.issuedAt),
      locationId: input.order.branchId,
      collectedById: input.actorId,
      createdById: input.actorId,
    },
    select: {
      id: true,
      amount: true,
      expiresAt: true,
      createdAt: true,
      paymentReference: true,
    },
  });
}
