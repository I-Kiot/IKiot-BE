import { assertHoldsStock } from './stockable';

describe('assertHoldsStock', () => {
  it('passes products', () => {
    expect(() =>
      assertHoldsStock([{ id: '1', sku: 'A', itemType: 'PRODUCT' }]),
    ).not.toThrow();
  });

  it('refuses combos and services, naming them', () => {
    let body: { code: string; message: string } | undefined;
    try {
      assertHoldsStock([
        { id: '1', sku: 'A', itemType: 'PRODUCT' },
        { id: '2', sku: 'BO-AN', itemType: 'COMBO' },
        { id: '3', sku: 'LAP-DAT', itemType: 'SERVICE' },
      ]);
    } catch (error) {
      body = (
        error as { getResponse(): { code: string; message: string } }
      ).getResponse();
    }
    expect(body?.code).toBe('PRODUCT_ITEM_NOT_STOCKABLE');
    expect(body?.message).toContain('BO-AN');
    expect(body?.message).toContain('LAP-DAT');
    expect(body?.message).not.toContain('A (');
  });
});
