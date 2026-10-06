import { ORDER_PRIORITIES } from '../../common/constants/order-status';
import {
  ON_ORDER_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';

// The production list (docs/hanh-trinh-don-hang.md GĐ1 – Bước 4, contract §3) as pure functions:
// no database, so every rule about "how many are short" is unit-tested on its own, the way
// pricing-engine.ts and payroll-math.ts are. The service loads the rows and decorates the result.
//
// Every SKU of the catalogue can be ordered from a workshop, short or not (2026-10-05): the list
// is the whole catalogue at each location, and "how many are short" is one column of it plus a
// filter, with the short rows sorted first.
//
// One row is one (location, SKU) - or, for a piece made to one order line's own design, one
// (location, SKU, order line): a custom piece is only ever for that line, so it can neither be
// covered by shelf stock nor cover anybody else's demand.
//
//   shortQuantity = max(0, demand − stock − onOrder − draft)
//
// `stock` is the TOTAL stock (`inventories.stock`), not the shelf (`stock − locked_stock`):
// demand includes lines of orders already PACKED / PICKED_UP, and their goods are exactly what
// `locked_stock` holds. Subtracting the shelf would count those orders short a second time.

/** One unshipped, stocked order line - the demand. `locationId` null = no source location chosen yet. */
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

/** `inventories.stock` at one place. */
export interface StockLevelRow {
  locationId: string;
  productItemId: string;
  stock: number;
}

/** What is left of a lot made for one custom order line (`inventory_lots.order_item_id`). Part of `stock`, but nobody else's. */
export interface CustomLotRow {
  locationId: string;
  productItemId: string;
  orderItemId: string;
  remaining: number;
}

/** One line of an open production request (DRAFT, SENT or PARTIALLY_RECEIVED). */
export interface RequestLine {
  requestId: string;
  code: string;
  status: string;
  supplierName: string;
  expectedReadyDate: Date | null;
  locationId: string;
  productItemId: string;
  /** Set only when the line makes a custom piece for this order line - a standard line linked to an order counts toward the standard row. */
  customOrderItemId: string | null;
  quantity: number;
  receivedQuantity: number;
}

export interface ProductionListEntry {
  key: string;
  locationId: string | null;
  productItemId: string;
  /** The order line a custom row is for; null on a standard row. */
  customOrderItemId: string | null;
  stock: number;
  demandQuantity: number;
  onOrderQuantity: number;
  draftQuantity: number;
  shortQuantity: number;
  /** Most urgent first: priority, then the delivery date the customer asked for. */
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

/** Higher = more urgent. ORDER_PRIORITIES is listed lowest first; an unknown value sorts as the lowest. */
function priorityRank(priority: string): number {
  return Math.max(0, ORDER_PRIORITIES.indexOf(priority));
}

/** Who goes first when several orders want the same goods: priority tag, then the earliest delivery date asked for (none = last), then the order code for a stable result. */
export function compareUrgency(a: DemandLine, b: DemandLine): number {
  const byPriority = priorityRank(b.priority) - priorityRank(a.priority);
  if (byPriority !== 0) return byPriority;
  const ta = a.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  const tb = b.requestedDeliveryDate?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.orderCode.localeCompare(b.orderCode);
}

/** The whole list. Rows come from the demand, from open requests and from `catalogue` - the (location, SKU) pairs to list even with nothing going on, so anything can be ordered. Short rows first (most urgent order first, then the largest gap), then rows with orders behind them; rows that tie keep their input order, which the caller sorts by name. */
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
  // Custom pieces are inside `stock` but reserved by construction for their own line.
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

/** Short first, then rows with orders; within each, the most urgent order, then the largest gap. 0 for two rows with no orders - the caller orders those by name. */
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

/** Did this change just make a row short? Edge-triggered like `crossedLowStock` and `crossedCreditWarning`: it fires on the edit that opens the gap, not on every later edit while the gap stays open - or the people watching the list mute it on day one. */
export function crossedShortage(before: number, after: number): boolean {
  return before <= 0 && after > 0;
}
