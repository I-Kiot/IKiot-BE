import type { ComboEdge } from '../orders/combo-expansion';
import { MAX_COMBO_DEPTH } from '../orders/combo-expansion';
import {
  assertComboGraph,
  assertComponentsMatchType,
  assertNoDiscontinuedComponent,
  comboCostOf,
} from './combo-components';

const item = (id: string, itemType = 'PRODUCT') => ({
  id,
  sku: id,
  productName: id,
  vat: null,
  itemType,
});
const edge = (
  comboItemId: string,
  childId: string,
  childType = 'PRODUCT',
  quantity = 1,
): ComboEdge => ({
  comboItemId,
  quantity,
  componentItem: item(childId, childType),
});
const graph = (...edges: ComboEdge[]) => {
  const map = new Map<string, ComboEdge[]>();
  for (const e of edges) {
    map.set(e.comboItemId, [...(map.get(e.comboItemId) ?? []), e]);
  }
  return map;
};
const code = (fn: () => void) => {
  try {
    fn();
  } catch (error) {
    return (error as { getResponse(): { code: string } }).getResponse().code;
  }
  return undefined;
};

describe('assertComboGraph', () => {
  it('accepts a nested combo', () => {
    // phòng ngủ = bộ giường + tủ; bộ giường = giường + 2 tab
    const existing = graph(
      edge('bed-set', 'bed'),
      edge('bed-set', 'nightstand', 'PRODUCT', 2),
    );
    expect(() =>
      assertComboGraph(
        'bedroom',
        [edge('bedroom', 'bed-set', 'COMBO'), edge('bedroom', 'wardrobe')],
        existing,
      ),
    ).not.toThrow();
  });

  it('refuses a cycle through another combo', () => {
    // B đã chứa A; giờ cho A chứa B.
    const existing = graph(edge('B', 'A', 'COMBO'), edge('A', 'chair'));
    expect(
      code(() => assertComboGraph('A', [edge('A', 'B', 'COMBO')], existing)),
    ).toBe('PRODUCT_COMBO_INVALID');
  });

  it('refuses a sub-combo with no components', () => {
    expect(
      code(() =>
        assertComboGraph('A', [edge('A', 'empty', 'COMBO')], new Map()),
      ),
    ).toBe('PRODUCT_COMBO_INVALID');
  });

  it('refuses an edit that pushes a combo above it past the depth limit', () => {
    // Chuỗi đúng MAX_COMBO_DEPTH combo (top → … → leaf-combo); cho leaf-combo chứa thêm một combo là quá.
    const chain: ComboEdge[] = [];
    const ids = [
      'top',
      ...Array.from({ length: MAX_COMBO_DEPTH - 2 }, (_, i) => `c${i + 1}`),
      'leaf-combo',
    ];
    for (let i = 0; i < ids.length - 1; i++) {
      chain.push(edge(ids[i], ids[i + 1], 'COMBO'));
    }
    chain.push(edge('leaf-combo', 'chair'), edge('deeper', 'table'));
    const existing = graph(...chain);
    expect(() =>
      assertComboGraph('leaf-combo', [edge('leaf-combo', 'chair')], existing),
    ).not.toThrow();
    expect(
      code(() =>
        assertComboGraph(
          'leaf-combo',
          [edge('leaf-combo', 'deeper', 'COMBO')],
          existing,
        ),
      ),
    ).toBe('PRODUCT_COMBO_INVALID');
  });
});

describe('assertComponentsMatchType', () => {
  const one = [{ componentItemId: 'x', quantity: 1 }];

  it('requires components on a COMBO', () => {
    expect(code(() => assertComponentsMatchType('COMBO', undefined))).toBe(
      'PRODUCT_COMBO_INVALID',
    );
    expect(code(() => assertComponentsMatchType('COMBO', []))).toBe(
      'PRODUCT_COMBO_INVALID',
    );
    expect(() => assertComponentsMatchType('COMBO', one)).not.toThrow();
  });

  it('refuses components on anything else', () => {
    expect(code(() => assertComponentsMatchType('PRODUCT', one))).toBe(
      'PRODUCT_COMBO_INVALID',
    );
    expect(() => assertComponentsMatchType('SERVICE', undefined)).not.toThrow();
  });
});

describe('assertNoDiscontinuedComponent', () => {
  it('names every discontinued component by SKU', () => {
    let message = '';
    try {
      assertNoDiscontinuedComponent([
        { id: '1', sku: 'GHE-1', productStatus: 'DISCONTINUED' },
        { id: '2', sku: 'BAN-1', productStatus: 'ACTIVE' },
        { id: '3', sku: null, productStatus: 'DISCONTINUED' },
      ]);
    } catch (error) {
      const body = (
        error as { getResponse(): { code: string; message: string } }
      ).getResponse();
      expect(body.code).toBe('PRODUCT_COMBO_COMPONENT_DISCONTINUED');
      message = body.message;
    }
    expect(message).toContain('GHE-1');
    expect(message).toContain('3');
    expect(message).not.toContain('BAN-1');
  });

  it('passes live components, inactive ones included', () => {
    expect(() =>
      assertNoDiscontinuedComponent([
        { id: '1', sku: 'A', productStatus: 'ACTIVE' },
        { id: '2', sku: 'B', productStatus: 'INACTIVE' },
      ]),
    ).not.toThrow();
  });
});

describe('comboCostOf', () => {
  it('sums quantity x cost over the components', () => {
    expect(
      comboCostOf([
        { quantity: 1, costPrice: 1_000_000 },
        { quantity: 4, costPrice: 250_000 },
      ]),
    ).toBe(2_000_000);
  });

  it('rounds to two places like the column', () => {
    expect(comboCostOf([{ quantity: 3, costPrice: 0.335 }])).toBe(1.01);
  });
});
