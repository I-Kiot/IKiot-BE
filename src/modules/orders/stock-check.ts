import type { Prisma } from '../../../generated/prisma/client';
import {
  OrderItemStatus,
  OrderStatus,
  STOCKED_LINE_TYPES,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { STOCK_CHECK_SEVERITY, StockCheckStatus } from './order-read.constants';

// Kiểm số lượng dòng đơn có trên kệ lúc này, chỉ đọc.

export interface StockCheck {
  status: StockCheckStatus;
  stock: number;
  shortQuantity: number;
}

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

/** Các đơn đã có hàng khóa sẵn lúc đóng gói, nên dòng của chúng không thể thiếu. */
const PACKED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.PACKED,
  OrderStatus.PICKED_UP,
];

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

/** Tình trạng hàng tệ nhất của đơn, null nếu không dòng nào cần kiểm. */
export function summarizeStock(
  checks: (StockCheck | null | undefined)[],
): StockCheckStatus | null {
  const present = new Set(
    checks.filter((c): c is StockCheck => !!c).map((c) => c.status),
  );
  return STOCK_CHECK_SEVERITY.find((status) => present.has(status)) ?? null;
}

/** Dòng có cần tính stockCheck không. */
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

/** Tính stockCheck cho mọi dòng trong một truy vấn tồn. */
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
