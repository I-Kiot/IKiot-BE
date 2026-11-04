import type { Inventory } from '../../../generated/prisma/client';

/** Các trường mà luật đọc, để test truyền được dòng thiếu trường. */
export type StockLevel = Pick<Inventory, 'stock' | 'lockedStock' | 'minStock'>;

/** Tồn trên kệ = tổng trừ phần đã đóng gói cho đơn chưa giao. Đây là cách trừ duy nhất, không lưu nên không lệch khỏi hai cột gốc. */
export function actualStockOf(
  level: Pick<Inventory, 'stock' | 'lockedStock'>,
): number {
  return level.stock - level.lockedStock;
}

/**
 * Thay đổi này có kéo kệ của dòng qua ngưỡng không? `delta` là thay đổi trên kệ (`actualStockOf`), không phải `stock`.
 * Chỉ báo khi vượt ngưỡng (cạnh), không báo lại mỗi lần bán món đã thấp. `minStock = 0` tắt cảnh báo.
 */
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
