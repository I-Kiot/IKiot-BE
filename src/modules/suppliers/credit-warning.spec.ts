import { CREDIT_WARNING_RATIO, crossedCreditWarning } from './credit-warning';

const LIMIT = 100_000_000;
const THRESHOLD = CREDIT_WARNING_RATIO * LIMIT;

// Cùng lỗi như cảnh báo tồn thấp: bản bắn ở mọi lần nhận trên ngưỡng sẽ bị tắt, rồi cảnh báo thật cũng không ai đọc.
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
    // Nợ đã 80 triệu trước lần nhận 5 triệu này, nên cảnh báo đã gửi từ trước đó.
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
