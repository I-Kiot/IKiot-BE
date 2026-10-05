import { BadRequestException } from '@nestjs/common';
import { OrderLineType } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

/** How deep combos may nest (a combo inside a combo inside ...). Deep enough for "phòng ngủ = bộ giường + bộ tủ", shallow enough that a mistake in the catalogue is caught instead of walked. */
export const MAX_COMBO_DEPTH = 5;

/** The variant a combo component names - the fields an order line snapshots. */
export interface ComboItem {
  id: string;
  sku: string | null;
  productName: string;
  vat: unknown;
  itemType: string;
}

/** One `ComboComponent` row: `quantity` of `componentItem` in one `comboItemId`. */
export interface ComboEdge {
  comboItemId: string;
  quantity: number;
  componentItem: ComboItem;
}

/** One thing a combo finally hands the customer, and how many of it go in one combo. */
export interface ComboLeaf {
  item: ComboItem;
  quantity: number;
}

const invalid = (message: string) =>
  new BadRequestException({ code: ErrorCode.ORDER_COMBO_INVALID, message });

/**
 * What one `comboId` is made of, all the way down. A component that is itself a COMBO is opened
 * in turn and its quantities multiplied through, so the order only ever carries leaves (PRODUCT,
 * SERVICE) under the combo it sold - pack, ship and the production list then work exactly as for
 * a one-level combo. The same leaf reached two ways is merged into one line. A combo with no
 * components, a combo that contains itself, or nesting past `MAX_COMBO_DEPTH` is refused.
 */
export function flattenCombo(
  comboId: string,
  childrenOf: ReadonlyMap<string, readonly ComboEdge[]>,
): ComboLeaf[] {
  const leaves = new Map<string, ComboLeaf>();

  const walk = (id: string, multiplier: number, path: string[]) => {
    if (path.length > MAX_COMBO_DEPTH) {
      throw invalid(
        `Combo ${comboId} nests deeper than ${MAX_COMBO_DEPTH} levels`,
      );
    }
    const edges = childrenOf.get(id);
    if (!edges || edges.length === 0) {
      throw invalid(`Combo ${id} has no components`);
    }
    for (const edge of edges) {
      const quantity = multiplier * edge.quantity;
      const child = edge.componentItem;
      if (child.itemType === OrderLineType.COMBO) {
        if (path.includes(child.id)) {
          throw invalid(`Combo ${child.id} contains itself`);
        }
        walk(child.id, quantity, [...path, child.id]);
        continue;
      }
      const seen = leaves.get(child.id);
      if (seen) seen.quantity += quantity;
      else leaves.set(child.id, { item: child, quantity });
    }
  };

  walk(comboId, 1, [comboId]);
  return [...leaves.values()];
}
