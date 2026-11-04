import { ORDER_PRIORITIES } from '../../common/constants/order-status';
import {
  ON_ORDER_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';

// Danh sách cần sản xuất (docs/hanh-trinh-don-hang.md GĐ1 – Bước 4, contract §3) dưới dạng hàm thuần, không DB,
// để mọi quy tắc "thiếu bao nhiêu" được unit test riêng. Service tải dòng và trang trí kết quả.
//
// Mọi SKU sản xuất được (`Product.isManufacturable`, từ 2026-10-13; trước đó là mọi SKU) đều đặt được từ xưởng, thiếu hay không
// (2026-10-05): danh sách là danh mục đó ở mỗi địa điểm, "thiếu bao nhiêu" là một cột kèm bộ lọc, dòng thiếu lên trước.
// Dòng thiếu lấy từ nhu cầu, nên SKU chỉ mua từ NCC vẫn hiện khi đơn bị thiếu; dòng mang `isManufacturable: false` và được
// nhập lại qua đơn nhập hàng ("Tạo đơn nhập hàng"), không bao giờ qua yêu cầu.
//
// Một dòng là một (địa điểm, SKU), hoặc với hàng làm theo thiết kế của một dòng đơn là (địa điểm, SKU, dòng đơn):
// hàng tuỳ chỉnh chỉ dành cho dòng đó, nên không được phủ bằng hàng trên kệ, cũng không phủ nhu cầu của ai khác.
//
//   shortQuantity = max(0, demand − stock − onOrder − draft)
//
// `stock` là TỔNG tồn (`inventories.stock`), không phải phần trên kệ (`stock − locked_stock`): nhu cầu gồm cả dòng của
// đơn đã PACKED / PICKED_UP, và đúng hàng đó nằm trong `locked_stock`. Trừ phần trên kệ sẽ tính các đơn đó thiếu lần thứ hai.

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

/** Phần còn lại của lot làm cho một dòng đơn tuỳ chỉnh (`inventory_lots.order_item_id`). Nằm trong `stock`, nhưng không của ai khác. */
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
  quantity: number;
  receivedQuantity: number;
}

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
  orders: DemandLine[];
  requests: (RequestLine & { outstanding: number })[];
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

/** Ai đi trước khi nhiều đơn cần cùng hàng: nhãn ưu tiên, rồi ngày giao sớm nhất (không có = cuối), rồi mã đơn để kết quả ổn định. */
export function compareUrgency(a: DemandLine, b: DemandLine): number {
  const byPriority = priorityRank(b.priority) - priorityRank(a.priority);
  if (byPriority !== 0) return byPriority;
  const ta = a.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.orderCode.localeCompare(b.orderCode);
}

/** Toàn bộ danh sách. Dòng lấy từ nhu cầu, yêu cầu đang mở và `catalogue` (các cặp cần liệt kê dù chưa có gì, để đặt được bất kỳ thứ gì). Dòng thiếu lên trước (đơn gấp nhất trước, rồi khoảng thiếu lớn nhất), rồi tới dòng có đơn; dòng bằng nhau giữ thứ tự đầu vào, người gọi sắp theo tên. */
export function buildProductionList(input: {
  demand: DemandLine[];
  stock: StockLevelRow[];
  customLots: CustomLotRow[];
  requests: RequestLine[];
  catalogue?: { locationId: string; productItemId: string }[];
}): ProductionListEntry[] {
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
    const row = rowFor(
      line.locationId,
      line.productItemId,
      line.isCustom ? line.orderItemId : null,
    );
    row.demandQuantity += line.quantity;
    row.orders.push(line);
  }

  for (const line of input.requests) {
    const outstanding = Math.max(0, line.quantity - line.receivedQuantity);
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
  }

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

  return [...rows.values()].sort(compareRows);
}

/** Thiếu trước, rồi dòng có đơn; trong mỗi nhóm, đơn gấp nhất, rồi khoảng thiếu lớn nhất. 0 cho hai dòng không có đơn – người gọi sắp hai dòng đó theo tên. */
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

/** Thay đổi này vừa làm dòng thiếu hàng à? Bắt cạnh như `crossedLowStock` và `crossedCreditWarning`: chỉ bắn ở lần sửa mở ra khoảng thiếu, không bắn ở mọi lần sửa sau khi khoảng thiếu còn mở – nếu không người theo dõi danh sách sẽ tắt nó ngay ngày đầu. */
export function crossedShortage(before: number, after: number): boolean {
  return before <= 0 && after > 0;
}
