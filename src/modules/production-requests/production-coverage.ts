import type { Prisma } from '../../../generated/prisma/client';
import { OPEN_PRODUCTION_REQUEST_STATUSES } from '../../common/constants/production-request-status';

/** YCSX còn chờ hàng của một dòng đơn (cho `production` trên dòng đơn và cho kiểm tra đặt vượt). */
export interface OrderLineProduction {
  /** Σ (đặt − đã nhận) trên các YCSX còn mở (nháp, đã gửi, nhận một phần). */
  openQuantity: number;
  requests: {
    id: string;
    code: string;
    status: string;
    quantity: number;
    receivedQuantity: number;
  }[];
}

export const NO_LINE_PRODUCTION: OrderLineProduction = {
  openQuantity: 0,
  requests: [],
};

/**
 * YCSX còn mở theo dòng đơn, một query cho cả lô. `excludeRequestId` bỏ qua các dòng của một YCSX (đang sửa chính nó).
 * Dòng đã nhận đủ (`received >= quantity`) vẫn được liệt kê nhưng không cộng vào `openQuantity`.
 */
export async function openProductionByOrderItem(
  reader: Pick<Prisma.TransactionClient, 'productionRequestItem'>,
  tenantId: string,
  orderItemIds: readonly string[],
  excludeRequestId?: string,
): Promise<Map<string, OrderLineProduction>> {
  const result = new Map<string, OrderLineProduction>();
  if (orderItemIds.length === 0) return result;
  const rows = await reader.productionRequestItem.findMany({
    where: {
      orderItemId: { in: [...orderItemIds] },
      productionRequest: {
        tenantId,
        status: { in: [...OPEN_PRODUCTION_REQUEST_STATUSES] },
        ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
      },
    },
    select: {
      orderItemId: true,
      quantity: true,
      receivedQuantity: true,
      productionRequest: { select: { id: true, code: true, status: true } },
    },
    orderBy: { productionRequest: { createdAt: 'asc' } },
  });
  for (const row of rows) {
    const key = row.orderItemId!;
    const entry = result.get(key) ?? { openQuantity: 0, requests: [] };
    entry.openQuantity += Math.max(0, row.quantity - row.receivedQuantity);
    entry.requests.push({
      id: row.productionRequest.id,
      code: row.productionRequest.code,
      status: row.productionRequest.status,
      quantity: row.quantity,
      receivedQuantity: row.receivedQuantity,
    });
    result.set(key, entry);
  }
  return result;
}
