/** How much of a supplier's credit limit has to be used before the owners are warned - the hardcoded `0.75` from the old receive path, fired once on the receipt that crosses the line. Applies to supplier imports and workshop receipts alike. */
export const CREDIT_WARNING_RATIO = 0.75;

/** Did this receipt just push a supplier's debt through the warning line? Edge-triggered like `crossedLowStock`, so it fires only on the crossing receipt; a credit limit of `0` or less means no limit set. */
export function crossedCreditWarning(
  debtAfter: number,
  amount: number,
  creditLimit: number,
): boolean {
  if (creditLimit <= 0 || amount <= 0) return false;

  const threshold = CREDIT_WARNING_RATIO * creditLimit;
  return debtAfter >= threshold && debtAfter - amount < threshold;
}
