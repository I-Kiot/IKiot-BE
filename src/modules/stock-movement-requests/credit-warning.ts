import { CREDIT_WARNING_RATIO } from './stock-movement.constants';

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
