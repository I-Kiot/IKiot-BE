import { resolveDeposit } from './manual-order.service';
import { ErrorCode } from '../../common/errors/error-codes';

describe('resolveDeposit', () => {
  it('is null when no deposit was taken', () => {
    expect(resolveDeposit(undefined, 1_000_000)).toBeNull();
  });

  it('takes a percentage of the grand total, rounded to the đồng', () => {
    expect(
      resolveDeposit({ type: 'PERCENT', value: 30, method: 'CASH' }, 1_234_567),
    ).toEqual({ amount: 370_370, percent: 30, method: 'CASH' });
  });

  it('keeps an amount as given, with no percentage', () => {
    expect(
      resolveDeposit(
        { type: 'AMOUNT', value: 500_000, method: 'BANK_TRANSFER' },
        2_000_000,
      ),
    ).toEqual({ amount: 500_000, percent: null, method: 'BANK_TRANSFER' });
  });

  it('allows the whole total', () => {
    expect(
      resolveDeposit({ type: 'PERCENT', value: 100, method: 'CASH' }, 900_000),
    ).toMatchObject({ amount: 900_000, percent: 100 });
  });

  it('treats a zero deposit as none, so no empty Payment is written', () => {
    expect(
      resolveDeposit({ type: 'AMOUNT', value: 0, method: 'CASH' }, 900_000),
    ).toBeNull();
    expect(
      resolveDeposit({ type: 'PERCENT', value: 0, method: 'CASH' }, 900_000),
    ).toBeNull();
  });

  it.each([
    [{ type: 'AMOUNT', value: 900_001, method: 'CASH' }],
    [{ type: 'PERCENT', value: 100.5, method: 'CASH' }],
  ])('refuses more than the order is worth (%o)', (deposit) => {
    let thrown: unknown;
    try {
      resolveDeposit(deposit, 900_000);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      response: { code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL },
    });
  });
});
