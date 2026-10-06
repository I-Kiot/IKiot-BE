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
      paymentStatus: 'REFUNDED',
    });
  });

  it('refunds part of it, in another method', () => {
    expect(resolveRefund([deposit], 1_000_000, 'BANK_TRANSFER')).toMatchObject({
      amount: 1_000_000,
      method: 'BANK_TRANSFER',
      paymentStatus: 'PARTIALLY_REFUNDED',
    });
  });

  it('keeps it all when the refund is 0', () => {
    expect(resolveRefund([deposit], 0, undefined)).toMatchObject({
      amount: 0,
      paymentStatus: 'PARTIALLY_PAID',
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
      paymentStatus: 'REFUNDED',
    });
  });

  it('refuses a refund on an order with nothing held', () => {
    expect(codeOf(() => resolveRefund([], 1, undefined))).toBe(
      ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
    );
  });
});
