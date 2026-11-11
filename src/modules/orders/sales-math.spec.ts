import { netLineValues } from './sales-math';

const line = (id: string, lineTotal: number, lineType = 'PRODUCT') => ({
  id,
  lineType,
  lineTotal,
});

describe('netLineValues', () => {
  it('leaves line totals alone without an order discount', () => {
    const net = netLineValues({ discountType: null, discountValue: 0 }, [
      line('a', 1000),
      line('b', 2500),
    ]);
    expect([...net.values()]).toEqual([1000, 2500]);
  });

  it('spreads an ORDER discount across the top-level lines so the parts add up exactly', () => {
    const lines = [line('a', 1000), line('b', 1000), line('c', 1000)];
    const net = netLineValues(
      { discountType: 'ORDER', discountValue: 100 },
      lines,
    );
    const total = [...net.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(2900);
    expect([...net.values()].sort()).toEqual([966, 967, 967].sort());
  });

  it('gives a combo component 0 (the COMBO parent carries the price) and ignores a PROMOTION discount', () => {
    const net = netLineValues(
      { discountType: 'PROMOTION', discountValue: 500 },
      [line('combo', 3000, 'COMBO'), line('part', 0, 'COMBO_COMPONENT')],
    );
    expect(net.get('combo')).toBe(3000);
    expect(net.get('part')).toBe(0);
  });

  it('never discounts below zero', () => {
    const net = netLineValues({ discountType: 'ORDER', discountValue: 5000 }, [
      line('a', 1000),
    ]);
    expect(net.get('a')).toBe(0);
  });
});

import {
  returnEntryAmounts,
  saleEntryAmounts,
  type SaleItemInput,
} from './sales-math';

const sold = (
  id: string,
  quantity: number,
  lineTotal: number,
  returnedQuantity = 0,
  lineType = 'PRODUCT',
): SaleItemInput => ({
  id,
  lineType,
  productItemId: `p-${id}`,
  quantity,
  returnedQuantity,
  lineTotal,
});

describe('saleEntryAmounts', () => {
  const order = { discountType: 'ORDER', discountValue: 100, shippingFee: 50 };

  it('books goods after the order discount plus shipping, with lines adding up to goods', () => {
    const items = [sold('a', 1, 1000), sold('b', 2, 2000)];
    const e = saleEntryAmounts({
      order,
      items,
      cogsByItem: new Map([
        ['a', 600],
        ['b', 1500],
      ]),
    });
    expect(e.goods).toBe(2900);
    expect(e.shipping).toBe(50);
    expect(e.total).toBe(2950);
    expect(e.cogs).toBe(2100);
    expect(e.lines.reduce((s, l) => s + l.amount, 0)).toBe(e.goods);
    expect(e.lines.reduce((s, l) => s + l.cogs, 0)).toBe(e.cogs);
  });

  it('nets goods returned before completion and keeps combo components at 0 with their own cost', () => {
    const items = [
      sold('combo', 1, 3000, 0, 'COMBO'),
      sold('part', 2, 0, 0, 'COMBO_COMPONENT'),
      sold('x', 4, 400, 1),
    ];
    const e = saleEntryAmounts({
      order: { discountType: null, discountValue: 0, shippingFee: 0 },
      items,
      cogsByItem: new Map([
        ['part', 1200],
        ['x', 300],
      ]),
    });
    expect(e.goods).toBe(3300);
    expect(e.lines.find((l) => l.orderItemId === 'part')).toMatchObject({
      quantity: 2,
      amount: 0,
      cogs: 1200,
    });
    expect(e.lines.find((l) => l.orderItemId === 'x')).toMatchObject({
      quantity: 3,
      amount: 300,
    });
  });
});

describe('returnEntryAmounts', () => {
  it('is negative, leaves shipping alone, and repeated returns add up to the line net', () => {
    const order = { discountType: 'ORDER', discountValue: 100 };
    const first = returnEntryAmounts({
      order,
      items: [sold('a', 3, 1000, 1), sold('b', 1, 1000)],
      returning: [{ orderItemId: 'a', quantity: 1 }],
      returnCogsByItem: new Map([['a', 200]]),
    });
    const second = returnEntryAmounts({
      order,
      items: [sold('a', 3, 1000, 3), sold('b', 1, 1000)],
      returning: [{ orderItemId: 'a', quantity: 2 }],
      returnCogsByItem: new Map([['a', 400]]),
    });
    expect(first.shipping).toBe(0);
    expect(first.goods).toBeLessThan(0);
    expect(first.cogs).toBe(-200);
    expect(first.lines[0].quantity).toBe(-1);
    // Line a net = 1000 - 50 (half of the 100 order discount) = 950.
    expect(first.goods + second.goods).toBe(-950);
  });
});
