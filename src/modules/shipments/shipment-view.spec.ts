import { amountStillDueOf } from './shipment-view';

const order = (
  grandTotal: number,
  depositAmount: number | null,
  payments: { kind: string; status: string; amount: number }[] = [],
) => ({ grandTotal, depositAmount, payments });

describe('amountStillDueOf', () => {
  it('is the total minus the deposit before the shipper collects', () => {
    expect(amountStillDueOf(order(430000, 260000))).toBe(170000);
  });

  it('is zero once the shipper has collected the balance', () => {
    const paid = [
      { kind: 'DEPOSIT', status: 'PAID', amount: 260000 },
      { kind: 'BALANCE', status: 'PAID', amount: 170000 },
    ];
    expect(amountStillDueOf(order(430000, 260000, paid))).toBe(0);
  });

  it('ignores a collection that is still pending', () => {
    const pending = [{ kind: 'BALANCE', status: 'PENDING', amount: 170000 }];
    expect(amountStillDueOf(order(430000, 260000, pending))).toBe(170000);
  });

  it('is zero for an order paid in full up front', () => {
    const full = [{ kind: 'FULL', status: 'PAID', amount: 430000 }];
    expect(amountStillDueOf(order(430000, null, full))).toBe(0);
  });

  it('counts a deposit that has no payment row from depositAmount', () => {
    expect(amountStillDueOf(order(430000, 100000))).toBe(330000);
  });

  it('owes nothing once a refund exists, and never goes below zero', () => {
    const refunded = [
      { kind: 'FULL', status: 'PAID', amount: 430000 },
      { kind: 'REFUND', status: 'PAID', amount: 100000 },
    ];
    expect(amountStillDueOf(order(430000, null, refunded))).toBe(0);
    const over = [{ kind: 'FULL', status: 'PAID', amount: 500000 }];
    expect(amountStillDueOf(order(430000, null, over))).toBe(0);
  });
});
