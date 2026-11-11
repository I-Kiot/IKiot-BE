import { type DepositPaymentRow, resolveRefund } from './order-cancel.service';
import { ErrorCode } from '../../common/errors/error-codes';

const payment = (
  over: Partial<DepositPaymentRow> & Pick<DepositPaymentRow, 'kind' | 'amount'>,
): DepositPaymentRow => ({
  id: `${over.kind}-${over.amount}`,
  status: 'PAID',
  method: 'CASH',
  createdAt: new Date('2026-10-01'),
  ...over,
});

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { response?: { code?: string } }).response?.code;
  }
  return undefined;
};

describe('resolveRefund', () => {
  const deposit = payment({ kind: 'DEPOSIT', amount: 3_000_000 });

  describe('money collected at the counter', () => {
    const balance = payment({
      kind: 'BALANCE',
      amount: 7_000_000,
      createdAt: new Date('2026-10-05'),
    });

    it('counts the balance as money held, with the deposit', () => {
      expect(
        resolveRefund([deposit, balance], 10_000_000, undefined),
      ).toMatchObject({
        held: 10_000_000,
        amount: 10_000_000,
        refundOfPaymentId: balance.id,
      });
    });

    it('refuses more than deposit and balance together', () => {
      expect(
        codeOf(() => resolveRefund([deposit, balance], 10_000_001, undefined)),
      ).toBe(ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT);
    });

    it('asks how much to refund when only a balance is held', () => {
      expect(codeOf(() => resolveRefund([balance], undefined, undefined))).toBe(
        ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED,
      );
    });

    it('refunds a QR payment by bank transfer: SePay only reports money coming in', () => {
      const qr = payment({ kind: 'BALANCE', amount: 500, method: 'SEPAY' });
      expect(resolveRefund([qr], 500, undefined)).toMatchObject({
        method: 'BANK_TRANSFER',
      });
    });

    it('ignores a QR still waiting for the money', () => {
      const waiting = payment({
        kind: 'BALANCE',
        amount: 500,
        method: 'SEPAY',
        status: 'PENDING',
      });
      expect(resolveRefund([waiting], undefined, undefined)).toBeNull();
    });
  });

  it('is null for an order with no deposit and no refund asked', () => {
    expect(resolveRefund([], undefined, undefined)).toBeNull();
    expect(resolveRefund([], 0, undefined)).toBeNull();
  });

  it('requires the amount when a deposit is held', () => {
    expect(codeOf(() => resolveRefund([deposit], undefined, undefined))).toBe(
      ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED,
    );
  });

  it('refunds all of it', () => {
    expect(resolveRefund([deposit], 3_000_000, undefined)).toMatchObject({
      held: 3_000_000,
      amount: 3_000_000,
      method: 'CASH',
      refundOfPaymentId: deposit.id,
    });
  });

  it('refunds part of it, in another method', () => {
    expect(resolveRefund([deposit], 1_000_000, 'BANK_TRANSFER')).toMatchObject({
      amount: 1_000_000,
      method: 'BANK_TRANSFER',
    });
  });

  it('keeps it all when the refund is 0', () => {
    expect(resolveRefund([deposit], 0, undefined)).toMatchObject({
      amount: 0,
    });
  });

  it('refuses more than is held, counting earlier refunds and ignoring unpaid rows', () => {
    const rows = [
      deposit,
      payment({ kind: 'REFUND', amount: 500_000 }),
      payment({ kind: 'DEPOSIT', amount: 9_000_000, status: 'PENDING' }),
    ];
    expect(codeOf(() => resolveRefund(rows, 2_500_001, undefined))).toBe(
      ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
    );
    expect(resolveRefund(rows, 2_500_000, undefined)).toMatchObject({
      held: 2_500_000,
    });
  });

  it('refuses a refund on an order with nothing held', () => {
    expect(codeOf(() => resolveRefund([], 1, undefined))).toBe(
      ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
    );
  });
});
