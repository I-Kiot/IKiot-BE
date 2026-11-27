import { derivePaymentStatus, paymentTotals } from './payment-status';
import { OrderPaymentStatus as S } from '../../common/constants/order-status';

const paid = (kind: string, amount: number) => ({
  kind,
  status: 'PAID',
  amount,
});

describe('derivePaymentStatus', () => {
  it('is UNPAID with no money', () => {
    expect(derivePaymentStatus(1000, [])).toMatchObject({
      status: S.UNPAID,
      due: 1000,
      net: 0,
      overpaidBy: 0,
    });
  });

  it('ignores anything that is not PAID', () => {
    const result = derivePaymentStatus(1000, [
      { kind: 'BALANCE', status: 'PENDING', amount: 1000 },
      { kind: 'BALANCE', status: 'EXPIRED', amount: 1000 },
      { kind: 'BALANCE', status: 'CANCELLED', amount: 1000 },
    ]);
    expect(result.status).toBe(S.UNPAID);
    expect(result.due).toBe(1000);
  });

  it('is PARTIALLY_PAID on a deposit', () => {
    expect(derivePaymentStatus(1000, [paid('DEPOSIT', 300)])).toMatchObject({
      status: S.PARTIALLY_PAID,
      due: 700,
      net: 300,
    });
  });

  it('is PAID when the deposit and the balance add up', () => {
    expect(
      derivePaymentStatus(1000, [paid('DEPOSIT', 300), paid('BALANCE', 700)]),
    ).toMatchObject({ status: S.PAID, due: 0, overpaidBy: 0 });
  });

  it('counts a FULL payment as received', () => {
    expect(derivePaymentStatus(1000, [paid('FULL', 1000)]).status).toBe(S.PAID);
  });

  it('flags an overpayment', () => {
    expect(derivePaymentStatus(1000, [paid('FULL', 1200)])).toMatchObject({
      status: S.PAID,
      due: 0,
      overpaidBy: 200,
    });
  });

  it('treats cash change as money handed back, not as a refund', () => {
    // Khách đưa 1.200.000, thối 200.000: đơn 1.000.000 vẫn là PAID.
    const result = derivePaymentStatus(1_000_000, [
      paid('FULL', 1_200_000),
      paid('CHANGE', 200_000),
    ]);
    expect(result).toMatchObject({
      status: S.PAID,
      net: 1_000_000,
      refunded: 0,
      overpaidBy: 0,
    });
  });

  it('REGRESSION: overpaid then refunded the excess is still PAID', () => {
    expect(
      derivePaymentStatus(1000, [paid('FULL', 1200), paid('REFUND', 200)]),
    ).toMatchObject({ status: S.PAID, due: 0, overpaidBy: 0 });
  });

  it('REGRESSION: a deposit kept on cancel stays PARTIALLY_PAID, not REFUNDED', () => {
    expect(derivePaymentStatus(1000, [paid('DEPOSIT', 300)]).status).toBe(
      S.PARTIALLY_PAID,
    );
  });

  it('is PARTIALLY_REFUNDED after a partial refund and owes nothing more', () => {
    expect(
      derivePaymentStatus(1000, [paid('DEPOSIT', 600), paid('REFUND', 200)]),
    ).toMatchObject({ status: S.PARTIALLY_REFUNDED, net: 400, due: 0 });
  });

  it('is REFUNDED once everything came back', () => {
    expect(
      derivePaymentStatus(1000, [paid('FULL', 1000), paid('REFUND', 1000)]),
    ).toMatchObject({ status: S.REFUNDED, net: 0, due: 0 });
  });

  it('works on Decimal-like amounts and rounds to đồng', () => {
    const decimal = (n: number) => ({ toNumber: () => n });
    expect(
      derivePaymentStatus(decimal(1000.0), [
        { kind: 'FULL', status: 'PAID', amount: decimal(999.6) },
      ]).status,
    ).toBe(S.PAID);
  });
});

describe('paymentTotals', () => {
  it('splits received / refunded / out / net', () => {
    expect(
      paymentTotals([
        paid('DEPOSIT', 500),
        paid('BALANCE', 500),
        paid('REFUND', 100),
        paid('CHANGE', 50),
      ]),
    ).toEqual({ received: 1000, refunded: 100, out: 150, net: 850 });
  });
});
