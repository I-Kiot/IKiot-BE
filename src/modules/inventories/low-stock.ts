import type { Inventory } from '../../../generated/prisma/client';

/** The fields the rules here read, so callers can pass a partial row in tests. */
export type StockLevel = Pick<Inventory, 'stock' | 'lockedStock' | 'minStock'>;

/** What is still on the shelf: the total less what is packed for orders that have not shipped. The one spelling of that subtraction - it is never stored, so it cannot drift from the two columns it comes from. */
export function actualStockOf(
  level: Pick<Inventory, 'stock' | 'lockedStock'>,
): number {
  return level.stock - level.lockedStock;
}

/**
 * Did this change just push a line's shelf stock through its low-stock threshold? `delta` is
 * the change in shelf stock (`actualStockOf`), not in `stock`: packing an order lowers the
 * shelf without touching the total, and shipping it lowers the total without touching the
 * shelf - goods already packed for someone cannot be sold, so it is the shelf that runs out.
 * Edge-triggered on purpose - a level test would re-fire on every later sale of an
 * already-short item. `minStock = 0` switches the alert off.
 */
export function crossedLowStock<T extends StockLevel>(
  after: T | null,
  delta: number,
): T | null {
  if (!after || delta >= 0) return null;
  if (after.minStock <= 0) return null;

  const actualAfter = actualStockOf(after);
  const actualBefore = actualAfter - delta; // delta is negative, so before > after
  const crossed =
    actualBefore > after.minStock && actualAfter <= after.minStock;
  return crossed ? after : null;
}
