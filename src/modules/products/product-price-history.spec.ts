import { priceChangeRows } from './product-price-history';

describe('priceChangeRows', () => {
  it('writes both prices with a null "from" for a new item', () => {
    expect(
      priceChangeRows(null, { retailPrice: 200000, costPrice: 100000 }),
    ).toEqual([
      { field: 'RETAIL_PRICE', from: null, to: 200000 },
      { field: 'COST_PRICE', from: null, to: 100000 },
    ]);
  });

  it('writes only the price that changed', () => {
    expect(
      priceChangeRows(
        { retailPrice: 200000, costPrice: 100000 },
        { retailPrice: 205000, costPrice: 100000 },
      ),
    ).toEqual([{ field: 'RETAIL_PRICE', from: 200000, to: 205000 }]);
  });

  it('ignores a field that was not sent', () => {
    expect(
      priceChangeRows(
        { retailPrice: 1, costPrice: 1 },
        { retailPrice: undefined, costPrice: 5 },
      ),
    ).toEqual([{ field: 'COST_PRICE', from: 1, to: 5 }]);
  });

  it('compares in whole dong, so a sub-dong difference is not a change', () => {
    expect(
      priceChangeRows(
        { retailPrice: '200000.00', costPrice: 1 },
        { retailPrice: 200000.4 },
      ),
    ).toEqual([]);
  });
});
