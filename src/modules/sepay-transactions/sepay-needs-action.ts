import type { Prisma } from '../../../generated/prisma/client';
import { SepayTransactionOutcome } from '../../common/constants/payment-method';
import { OrderPaymentStatus } from '../../common/constants/order-status';

/** Điều kiện giao dịch SePay cần người xử lý. */
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
