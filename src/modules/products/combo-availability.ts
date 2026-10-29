import { holdsStock } from '../../common/constants/product-status';
import type { ComboLeaf } from '../orders/combo-expansion';

/**
 * What a combo made only of services reports. Selling one deducts nothing, so it is never short;
 * a finite number because the API field is a plain count the till compares with `> 0`.
 */
export const SERVICE_ONLY_COMBO_SETS = 9999;

/** Goods on the shelf: what a sale may take. Packed-for-an-order stock (`lockedStock`) is not for sale, and `deductStock` refuses it with the same subtraction. */
export function shelfOf(row: { stock: number; lockedStock: number }): number {
  return Math.max(0, row.stock - row.lockedStock);
}

/**
 * How many whole sets of a combo the given shelf figures cover: the scarcest leaf decides, so one
 * item running out takes the whole combo with it. `leaves` are already flattened (`flattenCombo`),
 * each carrying how many it takes for ONE set, nested combos multiplied through. A SERVICE leaf has
 * nothing to run out of and is ignored.
 */
export function comboSetsAvailable(
  leaves: readonly ComboLeaf[],
  shelf: (itemId: string) => number,
): number {
  const stocked = leaves.filter((leaf) => holdsStock(leaf.item.itemType));
  if (stocked.length === 0) return SERVICE_ONLY_COMBO_SETS;
  return Math.min(
    ...stocked.map((leaf) =>
      Math.floor(Math.max(0, shelf(leaf.item.id)) / leaf.quantity),
    ),
  );
}
