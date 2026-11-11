import type { Prisma } from '../../../generated/prisma/client';
import { OrderPaymentStatus } from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { toDong, type MoneyLike } from '../../common/utils/money';

/**
 * MỘT quy tắc duy nhất cho `orders.payment_status`: suy ra từ các dòng `Payment` PAID và tổng đơn. Không nơi nào tự đặt trạng thái thanh toán; ghi một khoản tiền xong thì gọi `syncOrderPaymentStatus`.
 * Thuần (không đọc DB, không DI) để `pickupAmountDue`, `amountStillDueOf`, `depositHeld`, `resolveRefund` và chỗ thu tiền lúc giao đều là lớp mỏng trên cùng hàm này.
 * Mọi số là số nguyên đồng (`toDong`), không so sánh số thực.
 */

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

/**
 * Các khoản của đơn như quy tắc nhìn thấy: dòng Payment thật, cộng một khoản cọc PAID giả khi đơn có `depositAmount` mà không có dòng Payment cọc nào (đơn lập trước khi cọc có Payment, dữ liệu mẫu). Đơn mới luôn có dòng cọc thật nên nhánh này không chạy.
 * Một chỗ duy nhất cho khoản giả đó: `syncOrderPaymentStatus` và `amountStillDueOf` cùng đi qua đây nên không thể lệch nhau.
 */
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

/**
 * Đọc các khoản của đơn và tổng đơn TRONG transaction, suy ra trạng thái thanh toán, ghi vào `orders.payment_status` nếu khác, rồi trả các số đã suy ra.
 * Gọi sau MỌI lần ghi / đổi một `Payment` (và khi tổng đơn đổi); lệnh chiếm trạng thái đơn chỉ còn ghi `status` / `updatedAt`. Không ghi khi không đổi để không làm nhảy `updatedAt` vô cớ.
 * Đơn quầy chưa có dòng Payment (tới Phase 3) không được gọi hàm này: nó sẽ đọc ra UNPAID.
 */
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
