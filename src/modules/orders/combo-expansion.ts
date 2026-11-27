import { BadRequestException } from '@nestjs/common';
import { OrderLineType } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

/** Độ lồng tối đa của combo. */
export const MAX_COMBO_DEPTH = 5;

export interface ComboItem {
  id: string;
  sku: string | null;
  productName: string;
  vat: unknown;
  itemType: string;
}

export interface ComboEdge {
  comboItemId: string;
  quantity: number;
  componentItem: ComboItem;
}

export interface ComboLeaf {
  item: ComboItem;
  quantity: number;
}

const invalid = (message: string) =>
  new BadRequestException({ code: ErrorCode.ORDER_COMBO_INVALID, message });

/** Mở combo xuống các lá, nhân số lượng qua từng tầng và gộp lá trùng. */
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
