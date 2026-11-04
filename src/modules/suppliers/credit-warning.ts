/** Tỉ lệ hạn mức công nợ phải dùng tới trước khi cảnh báo chủ shop (`0.75` cứng từ đường nhận hàng cũ), chỉ bắn một lần ở lần nhận vượt ngưỡng. Áp dụng cho cả nhập NCC lẫn nhận từ thợ. */
export const CREDIT_WARNING_RATIO = 0.75;

/** Lần nhận này có đẩy công nợ NCC vượt ngưỡng cảnh báo không? Bắt cạnh như `crossedLowStock`, chỉ bắn ở đúng lần vượt; hạn mức `0` trở xuống nghĩa là không đặt hạn mức. */
export function crossedCreditWarning(
  debtAfter: number,
  amount: number,
  creditLimit: number,
): boolean {
  if (creditLimit <= 0 || amount <= 0) return false;

  const threshold = CREDIT_WARNING_RATIO * creditLimit;
  return debtAfter >= threshold && debtAfter - amount < threshold;
}
