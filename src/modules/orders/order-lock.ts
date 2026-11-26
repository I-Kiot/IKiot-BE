import type { Prisma } from '../../../generated/prisma/client';

/** Khoá dòng đơn (`FOR UPDATE`) đầu mọi transaction đụng tới tiền; false nếu không có đơn. */
export async function lockOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders WHERE id = ${orderId} AND tenant_id = ${tenantId} FOR UPDATE
  `;
  return rows.length === 1;
}
