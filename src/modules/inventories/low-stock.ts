import type { Inventory } from '../../../generated/prisma/client';

/** Các trường mà luật đọc, để test truyền được dòng thiếu trường. */
export type StockLevel = Pick<Inventory, 'stock' | 'lockedStock' | 'minStock'>;

/** Tồn trên kệ = tổng - phần đã khoá. */
export function actualStockOf(
  level: Pick<Inventory, 'stock' | 'lockedStock'>,
): number {
  return level.stock - level.lockedStock;
}

/** Thay đổi có kéo tồn trên kệ qua ngưỡng không. */
export function crossedLowStock<T extends StockLevel>(
  after: T | null,
  delta: number,
): T | null {
  if (!after || delta >= 0) return null;
  if (after.minStock <= 0) return null;

  const actualAfter = actualStockOf(after);
  const actualBefore = actualAfter - delta; // delta âm nên trước > sau
  const crossed =
    actualBefore > after.minStock && actualAfter <= after.minStock;
  return crossed ? after : null;
}
