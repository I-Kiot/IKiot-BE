import { crossedCreditWarning } from './credit-warning';
import { CREDIT_WARNING_RATIO } from './stock-movement.constants';

const LIMIT = 100_000_000;
const THRESHOLD = CREDIT_WARNING_RATIO * LIMIT; // 75,000,000

// Same failure mode as the low-stock warning: the version that fires on every receipt above the line is the one that gets muted, after which the real warnings go unread too.
describe('crossedCreditWarning', () => {
  it('fires on the receipt that lands exactly on the threshold', () => {
    expect(crossedCreditWarning(THRESHOLD, 5_000_000, LIMIT)).toBe(true);
  });

  it('fires on the receipt that jumps past the threshold', () => {
    expect(
      crossedCreditWarning(THRESHOLD + 10_000_000, 20_000_000, LIMIT),
    ).toBe(true);
  });

  it('stays quiet on later receipts once already above the threshold', () => {
    // Debt was already 80m before this 5m receipt - the warning went out then.
    expect(crossedCreditWarning(85_000_000, 5_000_000, LIMIT)).toBe(false);
  });

  it('stays quiet while the debt is still under the threshold', () => {
    expect(crossedCreditWarning(70_000_000, 10_000_000, LIMIT)).toBe(false);
  });

  it('stays quiet when the supplier has no credit limit set', () => {
    expect(crossedCreditWarning(90_000_000, 90_000_000, 0)).toBe(false);
  });

  it('stays quiet when nothing was charged', () => {
    expect(crossedCreditWarning(THRESHOLD, 0, LIMIT)).toBe(false);
  });
});
