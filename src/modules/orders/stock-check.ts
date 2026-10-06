import type { Prisma } from '../../../generated/prisma/client';
import {
  OrderItemStatus,
  OrderStatus,
  STOCKED_LINE_TYPES,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { STOCK_CHECK_SEVERITY, StockCheckStatus } from './order-read.constants';

// An order line's stockCheck (contract §2, journey GĐ1 - Bước 3): is the line's quantity on the
// shelf right now. Read-only - nothing here holds stock for the order. Written for A-9; B-2 owns
// the rule, and which location to count is still open (contract §8): until it is settled this
// counts the line's own `sourceLocationId`, the contract's proposal. Change it here, in one place.

export interface StockCheck {
  status: StockCheckStatus;
  /** On-shelf stock at the line's source location: `stock − lockedStock`. */
  stock: number;
  /** `max(0, quantity − stock)`. */
  shortQuantity: number;
}

/** The fields of one order line this needs. */
export interface StockCheckLine {
  id: string;
  productItemId: string;
  sourceLocationId: string | null;
  lineType: string;
  status: string;
  quantity: number;
}

export interface StockCheckOrder {
  status: string;
  items: StockCheckLine[];
}

/** Orders whose goods are already locked for them at `pack`, so their own lines cannot come up short. */
const PACKED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.PACKED,
  OrderStatus.PICKED_UP,
];

/** The journey's three cases: all of it on the shelf, some of it, none of it. */
export function classifyStock(quantity: number, onShelf: number): StockCheck {
  const stock = Math.max(0, onShelf);
  const shortQuantity = Math.max(0, quantity - stock);
  const status =
    shortQuantity === 0
      ? StockCheckStatus.ENOUGH
      : stock === 0
        ? StockCheckStatus.OUT
        : StockCheckStatus.PARTIAL;
  return { status, stock, shortQuantity };
}

/** An order's `stockSummary`: its worst line, or null when no line has a check (shipped, or only COMBO / SERVICE lines). */
export function summarizeStock(
  checks: (StockCheck | null | undefined)[],
): StockCheckStatus | null {
  const present = new Set(
    checks.filter((c): c is StockCheck => !!c).map((c) => c.status),
  );
  return STOCK_CHECK_SEVERITY.find((status) => present.has(status)) ?? null;
}

/** Does this line get a stockCheck at all? Only stock-carrying lines still waiting to ship, on an order that has not shipped, with a location to count. */
function isCheckable(
  order: StockCheckOrder,
  line: StockCheckLine,
): line is StockCheckLine & { sourceLocationId: string } {
  return (
    UNSHIPPED_ORDER_STATUSES.includes(order.status) &&
    STOCKED_LINE_TYPES.includes(line.lineType) &&
    line.status === OrderItemStatus.PENDING &&
    line.sourceLocationId !== null
  );
}

/**
 * Every checkable line's stockCheck, keyed by order line id; a line missing from the map has
 * `stockCheck: null`. One inventory query for all the orders given, whatever their number.
 *
 * Each line is compared on its own with on-shelf stock, which already excludes what packed
 * orders hold - so two CONFIRMED orders wanting the one cabinet left both read ENOUGH, and
 * whichever is packed first takes it (contract §2). A PACKED / PICKED_UP order's own goods are
 * among the locked ones, so its lines read ENOUGH.
 */
export async function computeStockChecks(
  reader: Pick<Prisma.TransactionClient, 'inventory'>,
  tenantId: string,
  orders: StockCheckOrder[],
): Promise<Map<string, StockCheck>> {
  const lines = orders.flatMap((order) =>
    order.items
      .filter((line) => isCheckable(order, line))
      .map((line) => ({ order, line })),
  );
  const checks = new Map<string, StockCheck>();
  if (lines.length === 0) return checks;

  const inventories = await reader.inventory.findMany({
    where: {
      tenantId,
      locationId: {
        in: [...new Set(lines.map(({ line }) => line.sourceLocationId))],
      },
      productItemId: {
        in: [...new Set(lines.map(({ line }) => line.productItemId))],
      },
    },
    select: {
      locationId: true,
      productItemId: true,
      stock: true,
      lockedStock: true,
    },
  });
  const onShelf = new Map(
    inventories.map((inv) => [
      `${inv.locationId}:${inv.productItemId}`,
      inv.stock - inv.lockedStock,
    ]),
  );

  for (const { order, line } of lines) {
    const shelf =
      onShelf.get(`${line.sourceLocationId}:${line.productItemId}`) ?? 0;
    const check = classifyStock(line.quantity, shelf);
    checks.set(
      line.id,
      PACKED_ORDER_STATUSES.includes(order.status)
        ? { ...check, status: StockCheckStatus.ENOUGH, shortQuantity: 0 }
        : check,
    );
  }
  return checks;
}
