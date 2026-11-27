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

// Ghi khoản thanh toán của đơn quầy.

type PosOrder = {
  id: string;
  tenantId: string;
  code: string;
  branchId: string;
  grandTotal: Prisma.Decimal | number;
  paymentReference: string | null;
};

/** Ghi tiền nhận ngay của đơn quầy: khoản vào, dòng thu, tiền thối nếu có. */
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
  // Đơn 0đ không có khoản nào.
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

/** Tạo khoản QR SePay chờ tiền của đơn quầy. */
export function openPosQrPayment(
  tx: Prisma.TransactionClient,
  input: {
    order: Pick<PosOrder, 'id' | 'tenantId' | 'branchId'>;
    kind: typeof PaymentKind.FULL | typeof PaymentKind.BALANCE;
    amount: number;
    reference: string;
    /** Mốc tính hạn mã QR. */
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
