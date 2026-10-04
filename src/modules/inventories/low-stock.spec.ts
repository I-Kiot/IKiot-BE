import { actualStockOf, crossedLowStock } from './low-stock';

const line = (stock: number, minStock: number, lockedStock = 0) => ({
  stock,
  lockedStock,
  minStock,
});

// This rule decides whether a manager's phone buzzes; the failure that matters is warning on every sale once stock is low, which gets the channel muted on day one.
describe('crossedLowStock', () => {
  it('fires on the step that lands exactly on the threshold', () => {
    expect(crossedLowStock(line(5, 5), -1)).not.toBeNull();
  });

  it('fires on the step that jumps past the threshold', () => {
    expect(crossedLowStock(line(3, 5), -4)).not.toBeNull();
  });

  it('stays quiet on every later sale below the threshold', () => {
    // Stock was 4 against a threshold of 5 - the warning already went out then.
    expect(crossedLowStock(line(3, 5), -1)).toBeNull();
  });

  it('stays quiet while stock is still above the threshold', () => {
    expect(crossedLowStock(line(9, 5), -1)).toBeNull();
  });

  it('stays quiet when stock goes up', () => {
    expect(crossedLowStock(line(2, 5), 10)).toBeNull();
  });

  it('stays quiet when the alert is switched off for that line', () => {
    expect(crossedLowStock(line(0, 0), -5)).toBeNull();
  });

  it('stays quiet when nothing moved', () => {
    expect(crossedLowStock(line(5, 5), 0)).toBeNull();
  });

  it('stays quiet when there is no line to judge', () => {
    expect(crossedLowStock(null, -5)).toBeNull();
  });

  // The threshold is against the shelf: goods packed for an order can no longer be sold.
  it('fires when packing an order takes the shelf through the threshold', () => {
    // 10 in total, 6 now packed: the shelf went 8 -> 4 against a threshold of 5.
    expect(crossedLowStock(line(10, 5, 6), -4)).not.toBeNull();
  });

  it('judges the shelf, not the total', () => {
    // The total (10) is well above 5, but only 5 are left on the shelf after this sale.
    expect(crossedLowStock(line(10, 5, 5), -1)).not.toBeNull();
  });
});

describe('actualStockOf', () => {
  it('is the total less what is packed for orders', () => {
    expect(actualStockOf({ stock: 10, lockedStock: 3 })).toBe(7);
  });
});
