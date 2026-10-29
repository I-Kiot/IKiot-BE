import type { ComboLeaf } from '../orders/combo-expansion';
import {
  comboSetsAvailable,
  SERVICE_ONLY_COMBO_SETS,
  shelfOf,
} from './combo-availability';

const leaf = (
  id: string,
  quantity: number,
  itemType = 'PRODUCT',
): ComboLeaf => ({
  item: { id, sku: id, productName: id, vat: null, itemType },
  quantity,
});

const shelf = (levels: Record<string, number>) => (id: string) =>
  levels[id] ?? 0;

describe('shelfOf', () => {
  it('is stock minus what is packed for orders', () => {
    expect(shelfOf({ stock: 10, lockedStock: 4 })).toBe(6);
  });

  it('never goes below zero', () => {
    expect(shelfOf({ stock: 2, lockedStock: 5 })).toBe(0);
  });
});

describe('comboSetsAvailable', () => {
  it('is the scarcest leaf: 5 tables but 7 chairs at 4 per set makes 1 set', () => {
    const leaves = [leaf('table', 1), leaf('chair', 4)];
    expect(comboSetsAvailable(leaves, shelf({ table: 5, chair: 7 }))).toBe(1);
  });

  it('rounds each leaf down to whole sets', () => {
    expect(comboSetsAvailable([leaf('chair', 4)], shelf({ chair: 11 }))).toBe(
      2,
    );
  });

  it('is 0 as soon as one leaf is out, whatever the others hold', () => {
    const leaves = [leaf('table', 1), leaf('chair', 4)];
    expect(comboSetsAvailable(leaves, shelf({ table: 50, chair: 0 }))).toBe(0);
  });

  it('is 0 when a leaf has no stock row at all', () => {
    expect(comboSetsAvailable([leaf('table', 1)], shelf({}))).toBe(0);
  });

  it('is 0 when a leaf has fewer than one set worth', () => {
    expect(comboSetsAvailable([leaf('chair', 6)], shelf({ chair: 5 }))).toBe(0);
  });

  it('ignores service leaves', () => {
    const leaves = [leaf('table', 1), leaf('install', 1, 'SERVICE')];
    expect(comboSetsAvailable(leaves, shelf({ table: 3 }))).toBe(3);
  });

  it('is never short when the combo is only services', () => {
    expect(comboSetsAvailable([leaf('install', 1, 'SERVICE')], shelf({}))).toBe(
      SERVICE_ONLY_COMBO_SETS,
    );
  });
});
