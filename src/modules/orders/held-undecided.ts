import { Prisma } from '../../../generated/prisma/client';
import { OrderStatus } from '../../common/constants/order-status';
import { SalesJournalEntryType } from '../../common/constants/sales-journal';
import { derivePaymentStatus, paymentRowsOf } from './payment-status';

/**
 * Tiền "treo chưa quyết định" (quyết định của user 2026-11-11: "giữ tiền treo, quyết định sau"): đơn đã kết thúc (RETURNED / CANCELLED) mà shop vẫn giữ tiền của khách, chưa hoàn và chưa ghi nhận là thu nhập.
 * Không có cột đánh dấu: SUY RA từ trạng thái đơn + sổ doanh thu + các khoản, nên không thể lệch với tiền thật. Đơn có `OTHER_INCOME` là đã quyết định giữ; đơn có `SALE` thì tiền giữ là một phần doanh thu đã ghi (RETURN âm lo phần hàng trả), không treo.
 * Treo = đơn kết thúc, KHÔNG có SALE, KHÔNG có OTHER_INCOME, và tiền đang giữ (thu trừ hoàn trừ thối) > 0.
 * Đây là MỘT quy tắc: `paymentSummary.heldUndecided`, `POST /orders/:id/settle-held` dùng `heldUndecidedOf` / `loadHeldUndecided`; `GET /stats/unreconciled` dùng bản SQL cùng quy tắc (`HELD_UNDECIDED_*_SQL`, e2e đối chiếu hai bản).
 */
const HELD_TERMINAL_STATUSES: readonly string[] = [
  OrderStatus.RETURNED,
  OrderStatus.CANCELLED,
];

export function heldUndecidedOf(input: {
  status: string;
  hasSale: boolean;
  hasOtherIncome: boolean;
  net: number;
}): number {
  if (!HELD_TERMINAL_STATUSES.includes(input.status)) return 0;
  if (input.hasSale || input.hasOtherIncome) return 0;
  return Math.max(0, input.net);
}

/** Đọc rồi áp `heldUndecidedOf` cho một đơn. Gọi trong transaction đã khoá đơn khi dùng để quyết định ghi. */
export async function loadHeldUndecided(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      status: true,
      grandTotal: true,
      depositAmount: true,
      payments: { select: { kind: true, status: true, amount: true } },
    },
  });
  const journal = await tx.salesJournalEntry.findMany({
    where: { orderId },
    select: { entryType: true },
  });
  const types = journal.map((e) => e.entryType);
  return heldUndecidedOf({
    status: order.status,
    hasSale: types.includes(SalesJournalEntryType.SALE),
    hasOtherIncome: types.includes(SalesJournalEntryType.OTHER_INCOME),
    net: derivePaymentStatus(order.grandTotal, paymentRowsOf(order)).net,
  });
}

/** Tiền đang giữ của đơn `o` bằng SQL (thu trừ hoàn trừ thối; cọc cũ chưa có dòng Payment tính như `paymentRowsOf`). */
export const HELD_NET_SQL = Prisma.sql`((
  SELECT COALESCE(SUM(CASE WHEN p.kind IN ('FULL', 'DEPOSIT', 'BALANCE') THEN p.amount
                           WHEN p.kind IN ('REFUND', 'CHANGE') THEN -p.amount ELSE 0 END), 0)
  FROM payments p WHERE p.order_id = o.id AND p.status = 'PAID')
  + CASE WHEN EXISTS (SELECT 1 FROM payments d WHERE d.order_id = o.id AND d.kind = 'DEPOSIT' AND d.status = 'PAID')
         THEN 0 ELSE COALESCE(o.deposit_amount, 0) END)`;

/** Điều kiện đơn `o` kết thúc mà chưa quyết định (kết hợp với `HELD_NET_SQL > 0`). */
export const HELD_UNDECIDED_ORDER_SQL = Prisma.sql`
  o.status IN ('RETURNED', 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM sales_journal_entries e
                   WHERE e.order_id = o.id AND e.entry_type IN ('SALE', 'OTHER_INCOME'))`;
