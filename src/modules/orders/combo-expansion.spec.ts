import {
  type ComboEdge,
  type ComboItem,
  flattenCombo,
  MAX_COMBO_DEPTH,
} from './combo-expansion';
import { ErrorCode } from '../../common/errors/error-codes';

const item = (id: string, itemType = 'PRODUCT'): ComboItem => ({
  id,
  sku: id,
  productName: id,
  vat: null,
  itemType,
});

const edge = (
  comboItemId: string,
  componentItem: ComboItem,
  quantity = 1,
): ComboEdge => ({ comboItemId, componentItem, quantity });

const graph = (...edges: ComboEdge[]) => {
  const map = new Map<string, ComboEdge[]>();
  for (const e of edges)
    map.set(e.comboItemId, [...(map.get(e.comboItemId) ?? []), e]);
  return map;
};

const quantities = (leaves: ReturnType<typeof flattenCombo>) =>
  Object.fromEntries(leaves.map((leaf) => [leaf.item.id, leaf.quantity]));

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { response?: { code?: string } }).response?.code;
  }
  return undefined;
};

describe('flattenCombo', () => {
  it('returns a one-level combo as its components', () => {
    const g = graph(edge('tu-ban', item('ban')), edge('tu-ban', item('tu'), 2));
    expect(quantities(flattenCombo('tu-ban', g))).toEqual({ ban: 1, tu: 2 });
  });

  it('opens a combo inside a combo and multiplies the quantities through', () => {
    const g = graph(
      edge('phong', item('tu-ban', 'COMBO'), 2),
      edge('phong', item('ghe'), 3),
      edge('tu-ban', item('ban')),
      edge('tu-ban', item('tu'), 2),
    );
    expect(quantities(flattenCombo('phong', g))).toEqual({
      ban: 2,
      tu: 4,
      ghe: 3,
    });
  });

  it('merges a leaf reached two ways into one line', () => {
    const g = graph(
      edge('phong', item('bo-an', 'COMBO')),
      edge('phong', item('ghe'), 2),
      edge('bo-an', item('ban')),
      edge('bo-an', item('ghe'), 4),
    );
    expect(quantities(flattenCombo('phong', g))).toEqual({ ban: 1, ghe: 6 });
  });

  it('keeps a service inside a combo as a leaf', () => {
    const g = graph(
      edge('tu-lap', item('tu')),
      edge('tu-lap', item('lap-dat', 'SERVICE')),
    );
    expect(flattenCombo('tu-lap', g).map((l) => l.item.itemType)).toEqual([
      'PRODUCT',
      'SERVICE',
    ]);
  });

  it('refuses a combo with no components, at any level', () => {
    expect(codeOf(() => flattenCombo('rong', graph()))).toBe(
      ErrorCode.ORDER_COMBO_INVALID,
    );
    const g = graph(edge('phong', item('rong', 'COMBO')));
    expect(codeOf(() => flattenCombo('phong', g))).toBe(
      ErrorCode.ORDER_COMBO_INVALID,
    );
  });

  it('refuses a combo that contains itself', () => {
    const g = graph(
      edge('a', item('b', 'COMBO')),
      edge('b', item('a', 'COMBO')),
    );
    expect(codeOf(() => flattenCombo('a', g))).toBe(
      ErrorCode.ORDER_COMBO_INVALID,
    );
  });

  it(`refuses nesting deeper than ${MAX_COMBO_DEPTH} levels`, () => {
    const levels = MAX_COMBO_DEPTH + 1;
    const edges: ComboEdge[] = [];
    for (let i = 0; i < levels; i++)
      edges.push(edge(`c${i}`, item(`c${i + 1}`, 'COMBO')));
    edges.push(edge(`c${levels}`, item('ban')));
    expect(codeOf(() => flattenCombo('c0', graph(...edges)))).toBe(
      ErrorCode.ORDER_COMBO_INVALID,
    );

    const ok: ComboEdge[] = [];
    for (let i = 0; i < MAX_COMBO_DEPTH - 1; i++)
      ok.push(edge(`c${i}`, item(`c${i + 1}`, 'COMBO')));
    ok.push(edge(`c${MAX_COMBO_DEPTH - 1}`, item('ban')));
    expect(quantities(flattenCombo('c0', graph(...ok)))).toEqual({ ban: 1 });
  });
});
