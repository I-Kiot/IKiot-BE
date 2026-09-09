import type { Inventory } from '../../../generated/prisma/client';

/** The two fields the rule actually reads, so callers can pass a partial row in tests. */
export type StockLevel = Pick<Inventory, 'stock' | 'minStock'>;

/** Did this change just push a line through its low-stock threshold? Edge-triggered on purpose - a level test would re-fire on every later sale of an already-short item. `minStock = 0` switches the alert off. */
export function crossedLowStock<T extends StockLevel>(
  after: T | null,
  delta: number,
): T | null {
  if (!after || delta >= 0) return null;
  if (after.minStock <= 0) return null;

  const before = after.stock - delta; // delta is negative, so before > after.stock
  const crossed = before > after.minStock && after.stock <= after.minStock;
  return crossed ? after : null;
}
