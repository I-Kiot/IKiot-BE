import type { Prisma } from '../../../generated/prisma/client';
import { OrderPaymentStatus } from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { toDong, type MoneyLike } from '../../common/utils/money';

/** Quy tắc suy ra trạng thái thanh toán của đơn từ các khoản PAID. */

export interface PaymentRow {
  kind: string;
  status: string;
  amount: MoneyLike;
}

export interface PaymentTotals {
  /** Σ khoản PAID loại FULL, DEPOSIT, BALANCE: tiền khách đã trả. */
  received: number;
  /** Σ khoản PAID loại REFUND: tiền đã hoàn. */
  refunded: number;
  /** Tiền ra cho khách: hoàn + tiền thối (CHANGE). */
  out: number;
  /** received − out: tiền shop đang giữ của đơn. */
  net: number;
}

export interface DerivedPayment extends PaymentTotals {
  status: string;
  /** Còn phải thu. 0 khi đã có hoàn tiền (đơn đã chốt theo hướng trả lại) hoặc đã đủ. */
  due: number;
  /** Khách trả dư so với tổng đơn. */
  overpaidBy: number;
}

/** Loại khoản là tiền vào của khách. */
const RECEIVED_KINDS: readonly string[] = [
  PaymentKind.FULL,
  PaymentKind.DEPOSIT,
  PaymentKind.BALANCE,
];

/** Tổng tiền đã thu / hoàn / ra / giữ. Khoản chưa PAID (QR đang chờ, đã huỷ, hết hạn) chưa phải tiền. */
export function paymentTotals(payments: readonly PaymentRow[]): PaymentTotals {
  let received = 0;
  let refunded = 0;
  let change = 0;
  for (const p of payments) {
    if (p.status !== PaymentRecordStatus.PAID) continue;
    const amount = toDong(p.amount);
    if (RECEIVED_KINDS.includes(p.kind)) received += amount;
    else if (p.kind === PaymentKind.REFUND) refunded += amount;
    else if (p.kind === PaymentKind.CHANGE) change += amount;
  }
  const out = refunded + change;
  return { received, refunded, out, net: received - out };
}

export function derivePaymentStatus(
  grandTotal: MoneyLike,
  payments: readonly PaymentRow[],
): DerivedPayment {
  const total = toDong(grandTotal);
  const totals = paymentTotals(payments);
  const { refunded, net } = totals;

  let status: string;
  if (refunded > 0 && net < total) {
    status =
      net <= 0
        ? OrderPaymentStatus.REFUNDED
        : OrderPaymentStatus.PARTIALLY_REFUNDED;
  } else if (net >= total) {
    status = OrderPaymentStatus.PAID;
  } else if (net > 0) {
    status = OrderPaymentStatus.PARTIALLY_PAID;
  } else {
    status = OrderPaymentStatus.UNPAID;
  }

  return {
    ...totals,
    status,
    due: refunded > 0 ? 0 : Math.max(0, total - net),
    overpaidBy: Math.max(0, net - total),
  };
}

/** Các khoản của đơn, thêm khoản cọc giả cho đơn cũ chưa có dòng cọc. */
export function paymentRowsOf(order: {
  depositAmount: MoneyLike;
  payments: readonly PaymentRow[];
}): PaymentRow[] {
  const rows = [...order.payments];
  const hasDepositRow = rows.some(
    (p) =>
      p.kind === PaymentKind.DEPOSIT && p.status === PaymentRecordStatus.PAID,
  );
  const legacy = toDong(order.depositAmount);
  if (!hasDepositRow && legacy > 0) {
    rows.push({
      kind: PaymentKind.DEPOSIT,
      status: PaymentRecordStatus.PAID,
      amount: legacy,
    });
  }
  return rows;
}

/** Tính lại và ghi trạng thái thanh toán của đơn. */
export async function syncOrderPaymentStatus(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<DerivedPayment> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      grandTotal: true,
      depositAmount: true,
      paymentStatus: true,
      payments: { select: { kind: true, status: true, amount: true } },
    },
  });
  const derived = derivePaymentStatus(order.grandTotal, paymentRowsOf(order));
  if (derived.status !== order.paymentStatus) {
    await tx.order.update({
      where: { id: orderId },
      data: { paymentStatus: derived.status },
    });
  }
  return derived;
}
