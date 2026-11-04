import { holdsStock } from '../../common/constants/product-status';
import type { ComboLeaf } from '../orders/combo-expansion';

/** Combo chỉ gồm dịch vụ không trừ kho nên không bao giờ hết; vẫn là số hữu hạn vì POS so với `> 0`. */
export const SERVICE_ONLY_COMBO_SETS = 9999;

/** Hàng trên kệ là phần được bán. `lockedStock` đã đóng gói cho đơn nên không bán; `deductStock` trừ đúng phép này. */
export function shelfOf(row: { stock: number; lockedStock: number }): number {
  return Math.max(0, row.stock - row.lockedStock);
}

/**
 * Số bộ combo đủ hàng theo kệ: món hết trước quyết định cả combo. `leaves` đã phẳng (`flattenCombo`),
 * SERVICE không có gì để hết nên bỏ qua.
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
