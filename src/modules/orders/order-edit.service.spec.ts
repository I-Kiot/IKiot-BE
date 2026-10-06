import { resolveEditedDeposit } from './order-edit.service';
import { ErrorCode } from '../../common/errors/error-codes';

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { getResponse(): { code: string } }).getResponse().code;
  }
  return undefined;
};

describe('resolveEditedDeposit', () => {
  it('leaves an order with no deposit without one', () => {
    expect(
      resolveEditedDeposit({
        sent: undefined,
        stored: null,
        grandTotal: 5_000_000,
        held: 0,
      }),
    ).toBeNull();
  });

  it('keeps an amount deposit as it is when the total changes', () => {
    expect(
      resolveEditedDeposit({
        sent: undefined,
        stored: { amount: 1_000_000, percent: null },
        grandTotal: 8_000_000,
        held: 1_000_000,
      }),
    ).toEqual({ amount: 1_000_000, percent: null });
  });

  it('refuses a percentage deposit that would no longer match the money taken', () => {
    let body: { code?: string; deposit?: unknown } = {};
    try {
      resolveEditedDeposit({
        sent: undefined,
        stored: { amount: 3_000_000, percent: 30 },
        grandTotal: 12_000_000,
        held: 3_000_000,
      });
    } catch (error) {
      body = (error as { getResponse(): typeof body }).getResponse();
    }
    expect(body.code).toBe(ErrorCode.ORDER_DEPOSIT_CHANGED);
    expect(body.deposit).toEqual({
      held: 3_000_000,
      amount: 3_600_000,
      difference: 600_000,
    });
  });

  it('accepts the deposit resent as the amount held, dropping the percentage', () => {
    expect(
      resolveEditedDeposit({
        sent: { type: 'AMOUNT', value: 3_000_000, method: 'CASH' },
        stored: { amount: 3_000_000, percent: 30 },
        grandTotal: 12_000_000,
        held: 3_000_000,
      }),
    ).toEqual({ amount: 3_000_000, percent: null });
  });

  it('refuses a new deposit, since no money was taken for it', () => {
    expect(
      codeOf(() =>
        resolveEditedDeposit({
          sent: { type: 'AMOUNT', value: 500_000, method: 'CASH' },
          stored: null,
          grandTotal: 5_000_000,
          held: 0,
        }),
      ),
    ).toBe(ErrorCode.ORDER_DEPOSIT_CHANGED);
  });

  it('refuses a kept amount deposit larger than the new total', () => {
    expect(
      codeOf(() =>
        resolveEditedDeposit({
          sent: undefined,
          stored: { amount: 4_000_000, percent: null },
          grandTotal: 3_000_000,
          held: 4_000_000,
        }),
      ),
    ).toBe(ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL);
  });
});
