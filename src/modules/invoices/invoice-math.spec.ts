import { nextInvoiceNumber, saleLines, saleTotal } from './invoice-math';

const item = (
  id: string,
  quantity: number,
  returnedQuantity: number,
  lineTotal: number,
) => ({
  id,
  lineType: 'PRODUCT',
  productItemId: `p-${id}`,
  quantity,
  returnedQuantity,
  lineTotal,
});

describe('invoice-math', () => {
  it('nets goods returned before issue out of the lines and the total, keeping the shipping fee', () => {
    const lines = [item('a', 4, 1, 360), item('b', 1, 1, 50)];
    const kept = saleLines({ discountType: null, discountValue: 0 }, lines);
    expect(kept).toHaveLength(1);
    expect(kept[0].quantity).toBe(3);
    expect(kept[0].amount).toBe(270);
    // 360 - 90 hàng trả = 270 cộng phí ship 30 (phí ship không hoàn khi trả hàng).
    expect(saleTotal(kept, 30)).toBe(300);
  });

  it('spreads an ORDER discount over the lines so the lines plus shipping add up to the order total', () => {
    const lines = [
      item('a', 1, 0, 1000),
      item('b', 1, 0, 1000),
      item('c', 1, 0, 1000),
    ];
    const kept = saleLines(
      { discountType: 'ORDER', discountValue: 100 },
      lines,
    );
    expect(kept.reduce((s, l) => s + l.amount, 0)).toBe(2900);
    expect(kept.reduce((s, l) => s + l.discount, 0)).toBe(100);
    // grandTotal = 3000 - 100 + 50 ship.
    expect(saleTotal(kept, 50)).toBe(2950);
  });

  it('numbers from the highest existing number', () => {
    expect(nextInvoiceNumber('HD', 0)).toBe('HD000001');
    expect(nextInvoiceNumber('HD', 41)).toBe('HD000042');
  });
});
