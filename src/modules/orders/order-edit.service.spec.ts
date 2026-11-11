import {
  assertEditAllowedByPayments,
  resolveEditedDeposit,
} from './order-edit.service';
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

describe('assertEditAllowedByPayments', () => {
  const paid = (kind: string, amount: number) => ({
    kind,
    status: 'PAID',
    amount,
  });

  it('lets a deposit-only order through: the deposit rules decide', () => {
    expect(() =>
      assertEditAllowedByPayments([paid('DEPOSIT', 500)], {
        grandTotal: 100,
        moneyChanged: true,
      }),
    ).not.toThrow();
  });

  it('locks the money once the balance was collected', () => {
    expect(
      codeOf(() =>
        assertEditAllowedByPayments(
          [paid('DEPOSIT', 300), paid('BALANCE', 700)],
          {
            grandTotal: 1500,
            moneyChanged: true,
          },
        ),
      ),
    ).toBe(ErrorCode.ORDER_EDIT_LOCKED_BY_PAYMENT);
  });

  it('names a total below what was paid, with both numbers', () => {
    try {
      assertEditAllowedByPayments([paid('FULL', 1000)], {
        grandTotal: 900,
        moneyChanged: true,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        {
          code: ErrorCode.ORDER_TOTAL_BELOW_PAID,
          paid: 1000,
          grandTotal: 900,
        },
      );
    }
  });

  it('still allows an edit that touches no money', () => {
    expect(() =>
      assertEditAllowedByPayments([paid('FULL', 1000)], {
        grandTotal: 1000,
        moneyChanged: false,
      }),
    ).not.toThrow();
  });

  it('ignores a collection that is still waiting for its transfer', () => {
    expect(() =>
      assertEditAllowedByPayments(
        [{ kind: 'BALANCE', status: 'PENDING', amount: 700 }],
        { grandTotal: 1500, moneyChanged: true },
      ),
    ).not.toThrow();
  });
});
