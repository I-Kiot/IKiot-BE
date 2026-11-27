/** Ngưỡng cảnh báo công nợ: 75% hạn mức. */
export const CREDIT_WARNING_RATIO = 0.75;

/** Lần nhận có đẩy công nợ vượt ngưỡng cảnh báo không. */
export function crossedCreditWarning(
  debtAfter: number,
  amount: number,
  creditLimit: number,
): boolean {
  if (creditLimit <= 0 || amount <= 0) return false;

  const threshold = CREDIT_WARNING_RATIO * creditLimit;
  return debtAfter >= threshold && debtAfter - amount < threshold;
}
