import { baseSkuOfCustom, customSkuOf } from './custom-sku';

describe('custom SKU', () => {
  it('reads back the base SKU of every generated custom SKU', () => {
    for (const base of ['BAN-SOI', 'SP000012', 'GHE-C1A2B3']) {
      const sku = customSkuOf(base);
      expect(sku).toMatch(/-C[0-9A-F]{6}$/);
      expect(baseSkuOfCustom(sku)).toBe(base);
    }
  });

  it('answers null for an ordinary SKU', () => {
    expect(baseSkuOfCustom('BAN-SOI')).toBeNull();
    expect(baseSkuOfCustom('-C1A2B3C')).toBeNull();
  });
});
