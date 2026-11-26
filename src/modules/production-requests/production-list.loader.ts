import type { Prisma } from '../../../generated/prisma/client';
import {
  FulfillmentType,
  OrderItemStatus,
  STOCKED_LINE_TYPES,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { OPEN_PRODUCTION_REQUEST_STATUSES } from '../../common/constants/production-request-status';
import { buildProductionState, type ProductionState } from './production-list';

/** Tải dữ liệu cho danh sách cần sản xuất. */
export type ProductionListReader = Pick<
  Prisma.TransactionClient,
  'orderItem' | 'productionRequestItem' | 'inventory' | 'inventoryLot'
>;

/** Dòng cần tải; `locationIds` null là mọi địa điểm. */
export interface ListScope {
  locationIds: string[] | null;
  productItemIds?: string[];
  /** Cặp cần liệt kê dù không có nhu cầu hay yêu cầu nào phía sau – chế độ danh mục. */
  catalogue?: { locationId: string; productItemId: string }[];
  /** Bỏ qua các dòng của một YCSX (đang sửa chính nó). */
  excludeRequestId?: string;
}

/** Cặp (địa điểm, SKU) mà lần sửa đơn chạm tới; B-3 so sánh trước và sau. */
export interface StockPair {
  locationId: string | null;
  productItemId: string;
}

export const pairKey = (locationId: string | null, productItemId: string) =>
  `${locationId ?? '-'}|${productItemId}`;

export async function loadProductionState(
  reader: ProductionListReader,
  tenantId: string,
  scope: ListScope,
): Promise<ProductionState> {
  const itemFilter = scope.productItemIds
    ? { productItemId: { in: scope.productItemIds } }
    : {};

  const [demandRows, requestRows] = await Promise.all([
    reader.orderItem.findMany({
      where: {
        ...itemFilter,
        status: OrderItemStatus.PENDING,
        lineType: { in: [...STOCKED_LINE_TYPES] },
        // Bán tại quầy (TAKEAWAY) được trả và trừ kho ngay, không bao giờ chờ xưởng.
        order: {
          tenantId,
          status: { in: [...UNSHIPPED_ORDER_STATUSES] },
          fulfillmentType: { not: FulfillmentType.TAKEAWAY },
        },
        ...(scope.locationIds
          ? { sourceLocationId: { in: scope.locationIds } }
          : {}),
      },
      select: {
        id: true,
        productItemId: true,
        quantity: true,
        isCustom: true,
        sourceLocationId: true,
        order: {
          select: {
            id: true,
            code: true,
            status: true,
            priority: true,
            requestedDeliveryDate: true,
            assigneeId: true,
          },
        },
      },
    }),
    reader.productionRequestItem.findMany({
      where: {
        ...itemFilter,
        productionRequest: {
          tenantId,
          status: { in: [...OPEN_PRODUCTION_REQUEST_STATUSES] },
          ...(scope.locationIds
            ? { locationId: { in: scope.locationIds } }
            : {}),
          ...(scope.excludeRequestId
            ? { id: { not: scope.excludeRequestId } }
            : {}),
        },
      },
      select: {
        productItemId: true,
        quantity: true,
        receivedQuantity: true,
        orderItem: { select: { id: true, isCustom: true } },
        productionRequest: {
          select: {
            id: true,
            code: true,
            status: true,
            expectedReadyDate: true,
            locationId: true,
            supplier: { select: { supplierName: true } },
          },
        },
      },
      // YCSX cũ nhất trừ vào dòng đơn trước (`allocateLinkedSupply`).
      orderBy: [{ productionRequest: { createdAt: 'asc' } }, { id: 'asc' }],
    }),
  ]);

  const locationIds = new Set<string>();
  const productItemIds = new Set<string>();
  for (const line of demandRows) {
    if (line.sourceLocationId) locationIds.add(line.sourceLocationId);
    productItemIds.add(line.productItemId);
  }
  for (const line of requestRows) {
    locationIds.add(line.productionRequest.locationId);
    productItemIds.add(line.productItemId);
  }
  for (const pair of scope.catalogue ?? []) {
    locationIds.add(pair.locationId);
    productItemIds.add(pair.productItemId);
  }
  if (productItemIds.size === 0) return { entries: [], coverage: new Map() };

  // Tập trên (mọi địa điểm × mọi SKU đã liệt kê); hàm thuần chỉ đọc các cặp nó cần.
  const pairWhere = {
    tenantId,
    locationId: { in: [...locationIds] },
    productItemId: { in: [...productItemIds] },
  };
  const [stockRows, customLots] =
    locationIds.size === 0
      ? [[], []]
      : await Promise.all([
          reader.inventory.findMany({
            where: pairWhere,
            select: { locationId: true, productItemId: true, stock: true },
          }),
          reader.inventoryLot.findMany({
            where: {
              ...pairWhere,
              orderItemId: { not: null },
              remainingQuantity: { gt: 0 },
              // Lô may riêng bị hỏng không phủ được đơn: đơn đó vẫn phải vào danh sách cần sản xuất.
              isSellable: true,
            },
            select: {
              locationId: true,
              productItemId: true,
              orderItemId: true,
              remainingQuantity: true,
            },
          }),
        ]);

  return buildProductionState({
    catalogue: scope.catalogue,
    demand: demandRows.map((line) => ({
      orderItemId: line.id,
      orderId: line.order.id,
      orderCode: line.order.code,
      orderStatus: line.order.status,
      priority: line.order.priority,
      requestedDeliveryDate: line.order.requestedDeliveryDate,
      assigneeId: line.order.assigneeId,
      locationId: line.sourceLocationId,
      productItemId: line.productItemId,
      quantity: line.quantity,
      isCustom: line.isCustom,
    })),
    stock: stockRows,
    customLots: customLots.map((lot) => ({
      locationId: lot.locationId,
      productItemId: lot.productItemId,
      orderItemId: lot.orderItemId!,
      remaining: lot.remainingQuantity,
    })),
    requests: requestRows.map((line) => ({
      requestId: line.productionRequest.id,
      code: line.productionRequest.code,
      status: line.productionRequest.status,
      supplierName: line.productionRequest.supplier.supplierName,
      expectedReadyDate: line.productionRequest.expectedReadyDate,
      locationId: line.productionRequest.locationId,
      productItemId: line.productItemId,
      customOrderItemId: line.orderItem?.isCustom ? line.orderItem.id : null,
      orderItemId: line.orderItem?.id ?? null,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
    })),
  });
}

/** Các dòng của những cặp (địa điểm, SKU) này. */
export async function productionStateForPairs(
  reader: ProductionListReader,
  tenantId: string,
  pairs: StockPair[],
  excludeRequestId?: string,
): Promise<ProductionState> {
  if (pairs.length === 0) return { entries: [], coverage: new Map() };
  const wanted = new Set(
    pairs.map((pair) => pairKey(pair.locationId, pair.productItemId)),
  );
  const state = await loadProductionState(reader, tenantId, {
    locationIds: null,
    productItemIds: [...new Set(pairs.map((pair) => pair.productItemId))],
    excludeRequestId,
  });
  return {
    entries: state.entries.filter((row) =>
      wanted.has(pairKey(row.locationId, row.productItemId)),
    ),
    coverage: state.coverage,
  };
}
