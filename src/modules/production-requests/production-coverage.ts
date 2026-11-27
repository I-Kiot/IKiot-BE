import type { Prisma } from '../../../generated/prisma/client';
import {
  OPEN_PRODUCTION_REQUEST_STATUSES,
  ProductionDeliveryStatus,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';
import type { PooledRequestRef } from './production-orderable';

/** YCSX gắn dòng đơn còn chờ hàng (cho `production` trên dòng đơn). */
export interface LinkedOpenRequest {
  id: string;
  code: string;
  status: string;
  quantity: number;
  receivedQuantity: number;
}

/** Tiến độ một YCSX gắn dòng đơn. */
export interface LineProductionProgress {
  id: string;
  code: string;
  status: string;
  supplierName: string;
  location: { id: string; name: string };
  sentAt: Date | null;
  /** Lúc xưởng xác nhận nhận làm; null = chưa. */
  acceptedAt: Date | null;
  /** Ngày dạng YYYY-MM-DD. */
  expectedReadyDate: string | null;
  quantity: number;
  receivedQuantity: number;
  /** Xưởng đã ghi giao (phiếu PENDING) nhưng nơi nhận chưa xác nhận. */
  deliveringQuantity: number;
  /** Đóng khi nhận thiếu. */
  closedShort: boolean;
}

export interface LinkedProduction {
  /** Σ (đặt − đã nhận) trên các YCSX còn mở (nháp, đã gửi, nhận một phần). */
  openQuantity: number;
  requests: LinkedOpenRequest[];
  progress: LineProductionProgress[];
}

/** `production` của một dòng đơn: phần gắn dòng + phần còn đặt được tính từ danh sách sản xuất chung. */
export interface OrderLineProduction extends LinkedProduction {
  /** Còn đặt xưởng được bao nhiêu cho dòng này (`orderableLinesOf`); null = không biết. */
  orderableQuantity: number | null;
  /** YCSX đặt chung cho cùng (địa điểm, SKU) đang che số thiếu. */
  coveringRequests: PooledRequestRef[];
}

export const NO_LINE_PRODUCTION: OrderLineProduction = {
  openQuantity: 0,
  requests: [],
  progress: [],
  orderableQuantity: null,
  coveringRequests: [],
};

/** YCSX gắn các dòng đơn trong một truy vấn. */
export async function linkedProductionByOrderItem(
  reader: Pick<Prisma.TransactionClient, 'productionRequestItem'>,
  tenantId: string,
  orderItemIds: readonly string[],
): Promise<Map<string, LinkedProduction>> {
  const result = new Map<string, LinkedProduction>();
  if (orderItemIds.length === 0) return result;
  const rows = await reader.productionRequestItem.findMany({
    where: {
      orderItemId: { in: [...orderItemIds] },
      productionRequest: {
        tenantId,
        status: { not: ProductionRequestStatus.CANCELLED },
      },
    },
    select: {
      orderItemId: true,
      quantity: true,
      receivedQuantity: true,
      deliveryLines: {
        where: { delivery: { status: ProductionDeliveryStatus.PENDING } },
        select: { quantity: true },
      },
      productionRequest: {
        select: {
          id: true,
          code: true,
          status: true,
          sentAt: true,
          acceptedAt: true,
          expectedReadyDate: true,
          location: { select: { id: true, name: true } },
          supplier: { select: { supplierName: true } },
        },
      },
    },
    orderBy: { productionRequest: { createdAt: 'asc' } },
  });
  for (const row of rows) {
    const key = row.orderItemId!;
    const entry = result.get(key) ?? {
      openQuantity: 0,
      requests: [],
      progress: [],
    };
    const request = row.productionRequest;
    if (OPEN_PRODUCTION_REQUEST_STATUSES.includes(request.status)) {
      entry.openQuantity += Math.max(0, row.quantity - row.receivedQuantity);
      entry.requests.push({
        id: request.id,
        code: request.code,
        status: request.status,
        quantity: row.quantity,
        receivedQuantity: row.receivedQuantity,
      });
    }
    entry.progress.push({
      id: request.id,
      code: request.code,
      status: request.status,
      supplierName: request.supplier.supplierName,
      location: request.location,
      sentAt: request.sentAt,
      acceptedAt: request.acceptedAt,
      expectedReadyDate:
        request.expectedReadyDate?.toISOString().slice(0, 10) ?? null,
      quantity: row.quantity,
      receivedQuantity: row.receivedQuantity,
      deliveringQuantity: row.deliveryLines.reduce(
        (sum, line) => sum + line.quantity,
        0,
      ),
      closedShort:
        request.status === ProductionRequestStatus.COMPLETED &&
        row.receivedQuantity < row.quantity,
    });
    result.set(key, entry);
  }
  return result;
}
