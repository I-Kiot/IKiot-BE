import type { Prisma } from '../../../generated/prisma/client';
import { SepayTransactionOutcome } from '../../common/constants/payment-method';
import { OrderPaymentStatus } from '../../common/constants/order-status';

/**
 * MỘT định nghĩa "giao dịch SePay cần người xử lý" cho `GET /sepay-transactions?unresolved=true` và `GET /stats/unreconciled`:
 * chưa `resolved_at` VÀ (tiền chưa chốt: REJECTED / UNMATCHED; hoặc chốt thiếu SETTLED_PARTIAL mà đơn CHƯA đủ tiền; hoặc khách trả dư).
 * Chuyển thiếu rồi đơn đã đủ (khách chuyển bù, hoặc thu tay) thì không còn việc gì phải làm. `branchId` giới hạn ở dòng đã gắn đơn của chi nhánh đó.
 */
export function sepayNeedsActionWhere(
  tenantId: string | null,
  branchId?: string,
): Prisma.SepayTransactionWhereInput {
  return {
    tenantId: tenantId ?? undefined,
    resolvedAt: null,
    OR: [
      {
        outcome: {
          in: [
            SepayTransactionOutcome.REJECTED,
            SepayTransactionOutcome.UNMATCHED,
          ],
        },
      },
      {
        outcome: SepayTransactionOutcome.SETTLED_PARTIAL,
        NOT: { order: { paymentStatus: OrderPaymentStatus.PAID } },
      },
      { excessAmount: { gt: 0 } },
    ],
    ...(branchId ? { order: { branchId } } : {}),
  };
}
