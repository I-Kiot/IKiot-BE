import {
  nextInvoiceNumber,
  returnedValue,
  saleLines,
  saleTotal,
} from './invoice-math';

describe('invoice-math', () => {
  it('prorates a line discount onto the returned goods', () => {
    // 4 x 100 with a 40 discount -> 360; one unit back is worth 90.
    expect(returnedValue({ quantity: 4, lineTotal: 360, returned: 1 })).toBe(
      90,
    );
    expect(returnedValue({ quantity: 4, lineTotal: 360, returned: 0 })).toBe(0);
  });

  it('nets goods returned before issue out of the lines and the total', () => {
    const lines = [
      { quantity: 4, returnedQuantity: 1, lineTotal: 360, unitPrice: 100 },
      { quantity: 1, returnedQuantity: 1, lineTotal: 50, unitPrice: 50 },
    ];
    const kept = saleLines(lines);
    expect(kept).toHaveLength(1);
    expect(kept[0].quantity).toBe(3);
    expect(kept[0].amount).toBe(270);
    // Shipping (30) stays: 360 + 50 + 30 = 440, minus 90 and 50 back.
    expect(saleTotal(440, lines)).toBe(300);
  });

  it('numbers from the highest existing number', () => {
    expect(nextInvoiceNumber('HD', 0)).toBe('HD000001');
    expect(nextInvoiceNumber('HD', 41)).toBe('HD000042');
  });
});
