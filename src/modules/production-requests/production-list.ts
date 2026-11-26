import { ORDER_PRIORITIES } from '../../common/constants/order-status';
import {
  ON_ORDER_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';

// Danh sách cần sản xuất dạng hàm thuần: thiếu = max(0, nhu cầu - tồn - đang đặt - nháp).

/** Một dòng đơn chưa giao, đã có hàng – là nhu cầu. `locationId` null = chưa chọn kho nguồn. */
export interface DemandLine {
  orderItemId: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  priority: string;
  requestedDeliveryDate: Date | null;
  assigneeId: string | null;
  locationId: string | null;
  productItemId: string;
  quantity: number;
  isCustom: boolean;
}

/** `inventories.stock` tại một nơi. */
export interface StockLevelRow {
  locationId: string;
  productItemId: string;
  stock: number;
}

/** Tồn của lô làm riêng cho một dòng đơn. */
export interface CustomLotRow {
  locationId: string;
  productItemId: string;
  orderItemId: string;
  remaining: number;
}

/** Một dòng của yêu cầu sản xuất đang mở (DRAFT, SENT hoặc PARTIALLY_RECEIVED). */
export interface RequestLine {
  requestId: string;
  code: string;
  status: string;
  supplierName: string;
  expectedReadyDate: Date | null;
  locationId: string;
  productItemId: string;
  /** Chỉ có khi dòng làm bản tuỳ chỉnh cho dòng đơn này; dòng chuẩn gắn với đơn thì tính vào dòng chuẩn. */
  customOrderItemId: string | null;
  /** Dòng đơn mà dòng YCSX gắn (chuẩn hoặc may đo); null = đặt chung. */
  orderItemId: string | null;
  quantity: number;
  receivedQuantity: number;
}

/** Một YCSX gắn dòng đơn đã nhận phần nhu cầu của dòng đó. */
export interface LinkedCover {
  requestId: string;
  code: string;
  status: string;
  quantity: number;
}

/** Phần nhu cầu của một dòng đơn đã có YCSX gắn riêng (cùng địa điểm + SKU) đứng ra nhận. */
export interface LineCoverage {
  orderItemId: string;
  locationId: string | null;
  productItemId: string;
  isCustom: boolean;
  quantity: number;
  coveredQuantity: number;
  remainingQuantity: number;
  coveredBy: LinkedCover[];
}

export type ListedDemand = DemandLine & {
  remainingQuantity: number;
  coveredQuantity: number;
  coveredBy: LinkedCover[];
};

export interface ProductionListEntry {
  key: string;
  locationId: string | null;
  productItemId: string;
  /** Dòng đơn mà dòng tuỳ chỉnh phục vụ; null với dòng chuẩn. */
  customOrderItemId: string | null;
  stock: number;
  demandQuantity: number;
  onOrderQuantity: number;
  draftQuantity: number;
  shortQuantity: number;
  /** Gấp nhất lên trước: ưu tiên, rồi ngày khách yêu cầu giao. */
  orders: ListedDemand[];
  /** `outstanding` = phần còn lại đặt chung của dòng (đã trừ phần dòng đơn gắn đã nhận). */
  requests: (RequestLine & { outstanding: number })[];
}

export interface ProductionState {
  entries: ProductionListEntry[];
  coverage: Map<string, LineCoverage>;
}

export interface ProductionListInput {
  demand: DemandLine[];
  stock: StockLevelRow[];
  customLots: CustomLotRow[];
  requests: RequestLine[];
  catalogue?: { locationId: string; productItemId: string }[];
}

/** YCSX gắn dòng đơn trừ vào nhu cầu của chính dòng đó trước. */
export function allocateLinkedSupply(
  demand: DemandLine[],
  requests: RequestLine[],
): { coverage: Map<string, LineCoverage>; pooled: number[] } {
  const coverage = new Map<string, LineCoverage>();
  for (const line of demand) {
    coverage.set(line.orderItemId, {
      orderItemId: line.orderItemId,
      locationId: line.locationId,
      productItemId: line.productItemId,
      isCustom: line.isCustom,
      quantity: line.quantity,
      coveredQuantity: 0,
      remainingQuantity: line.quantity,
      coveredBy: [],
    });
  }
  const pooled = requests.map((r) => {
    const out = Math.max(0, r.quantity - r.receivedQuantity);
    const cov = r.orderItemId ? coverage.get(r.orderItemId) : undefined;
    if (
      !cov ||
      cov.locationId !== r.locationId ||
      cov.productItemId !== r.productItemId ||
      out === 0
    ) {
      return out;
    }
    const take = Math.min(out, cov.remainingQuantity);
    if (take > 0) {
      cov.coveredQuantity += take;
      cov.remainingQuantity -= take;
      cov.coveredBy.push({
        requestId: r.requestId,
        code: r.code,
        status: r.status,
        quantity: take,
      });
    }
    return out - take;
  });
  return { coverage, pooled };
}

export function rowKey(
  locationId: string | null,
  productItemId: string,
  customOrderItemId: string | null,
): string {
  return `${locationId ?? '-'}|${productItemId}|${customOrderItemId ?? ''}`;
}

const stockKey = (locationId: string, productItemId: string) =>
  `${locationId}|${productItemId}`;

/** Số cao hơn = gấp hơn. ORDER_PRIORITIES liệt kê từ thấp tới cao; giá trị lạ được xếp thấp nhất. */
function priorityRank(priority: string): number {
  return Math.max(0, ORDER_PRIORITIES.indexOf(priority));
}

/** Thứ tự ưu tiên khi nhiều đơn cần cùng hàng. */
export function compareUrgency(a: DemandLine, b: DemandLine): number {
  const byPriority = priorityRank(b.priority) - priorityRank(a.priority);
  if (byPriority !== 0) return byPriority;
  const ta = a.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.orderCode.localeCompare(b.orderCode);
}

/** Dựng toàn bộ danh sách cần sản xuất, dòng thiếu lên trước. */
export function buildProductionList(
  input: ProductionListInput,
): ProductionListEntry[] {
  return buildProductionState(input).entries;
}

/** Như `buildProductionList`, kèm phần nhu cầu đã được YCSX gắn nhận. */
export function buildProductionState(
  input: ProductionListInput,
): ProductionState {
  const { coverage, pooled } = allocateLinkedSupply(
    input.demand,
    input.requests,
  );
  const totalStock = new Map<string, number>();
  for (const row of input.stock) {
    totalStock.set(stockKey(row.locationId, row.productItemId), row.stock);
  }
  // Hàng tuỳ chỉnh nằm trong `stock` nhưng theo cấu trúc đã dành cho dòng đơn của nó.
  const customTotal = new Map<string, number>();
  const customByLine = new Map<string, number>();
  for (const lot of input.customLots) {
    const sk = stockKey(lot.locationId, lot.productItemId);
    customTotal.set(sk, (customTotal.get(sk) ?? 0) + lot.remaining);
    const lk = rowKey(lot.locationId, lot.productItemId, lot.orderItemId);
    customByLine.set(lk, (customByLine.get(lk) ?? 0) + lot.remaining);
  }

  const rows = new Map<string, ProductionListEntry>();
  const rowFor = (
    locationId: string | null,
    productItemId: string,
    customOrderItemId: string | null,
  ): ProductionListEntry => {
    const key = rowKey(locationId, productItemId, customOrderItemId);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        locationId,
        productItemId,
        customOrderItemId,
        stock: 0,
        demandQuantity: 0,
        onOrderQuantity: 0,
        draftQuantity: 0,
        shortQuantity: 0,
        orders: [],
        requests: [],
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const pair of input.catalogue ?? []) {
    rowFor(pair.locationId, pair.productItemId, null);
  }

  for (const line of input.demand) {
    const cov = coverage.get(line.orderItemId)!;
    // Dòng đã có YCSX gắn nhận đủ thì không còn nhu cầu để liệt kê.
    if (cov.remainingQuantity === 0) continue;
    const row = rowFor(
      line.locationId,
      line.productItemId,
      line.isCustom ? line.orderItemId : null,
    );
    row.demandQuantity += cov.remainingQuantity;
    row.orders.push({
      ...line,
      remainingQuantity: cov.remainingQuantity,
      coveredQuantity: cov.coveredQuantity,
      coveredBy: cov.coveredBy,
    });
  }

  input.requests.forEach((line, i) => {
    const outstanding = pooled[i];
    const total = Math.max(0, line.quantity - line.receivedQuantity);
    // Dòng YCSX bị dòng đơn của nó nhận hết: không còn gì đặt chung để hiện.
    if (total > 0 && outstanding === 0) return;
    const row = rowFor(
      line.locationId,
      line.productItemId,
      line.customOrderItemId,
    );
    row.requests.push({ ...line, outstanding });
    if (line.status === ProductionRequestStatus.DRAFT) {
      row.draftQuantity += outstanding;
    } else if (ON_ORDER_PRODUCTION_REQUEST_STATUSES.includes(line.status)) {
      row.onOrderQuantity += outstanding;
    }
  });

  for (const row of rows.values()) {
    if (row.locationId) {
      const sk = stockKey(row.locationId, row.productItemId);
      row.stock = row.customOrderItemId
        ? (customByLine.get(row.key) ?? 0)
        : Math.max(0, (totalStock.get(sk) ?? 0) - (customTotal.get(sk) ?? 0));
    }
    row.shortQuantity = Math.max(
      0,
      row.demandQuantity - row.stock - row.onOrderQuantity - row.draftQuantity,
    );
    row.orders.sort(compareUrgency);
  }

  return { entries: [...rows.values()].sort(compareRows), coverage };
}

/** So sánh dòng: thiếu trước, rồi dòng có đơn. */
export function compareRows(
  a: ProductionListEntry,
  b: ProductionListEntry,
): number {
  const shortFirst = Number(b.shortQuantity > 0) - Number(a.shortQuantity > 0);
  if (shortFirst !== 0) return shortFirst;
  const ua = a.orders[0];
  const ub = b.orders[0];
  if (ua && ub) {
    const byUrgency = compareUrgency(ua, ub);
    if (byUrgency !== 0) return byUrgency;
  } else if (ua || ub) {
    return ua ? -1 : 1;
  }
  return b.shortQuantity - a.shortQuantity;
}

/** Dòng vừa chuyển sang thiếu do thay đổi này. */
export function crossedShortage(before: number, after: number): boolean {
  return before <= 0 && after > 0;
}
