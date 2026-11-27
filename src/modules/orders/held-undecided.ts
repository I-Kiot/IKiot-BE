import { Prisma } from '../../../generated/prisma/client';
import { OrderStatus } from '../../common/constants/order-status';
import { SalesJournalEntryType } from '../../common/constants/sales-journal';
import { derivePaymentStatus, paymentRowsOf } from './payment-status';

/** Tiền treo: đơn đã kết thúc mà shop vẫn giữ tiền, chưa hoàn và chưa ghi thu nhập khác. */
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

/** Đọc tiền treo của một đơn. */
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

/** SQL tính tiền shop đang giữ của đơn. */
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
