// Port từ src/constants/subscription.js của iKiotMS-BE.
export const GRACE_PERIOD_DAYS = 3;
export const REMINDER_DAYS = [7, 3, 1];
export const BILLING_DAYS: Record<string, number> = {
  MONTHLY: 30,
  YEARLY: 365,
};
export const QR_EXPIRY_MS = 15 * 60 * 1000;

/** Kết cục của một giao dịch trong sổ `platform_sepay_transactions` (SQL CHECK cùng danh sách). */
export const PlatformTransferOutcome = {
  ACTIVATED: 'ACTIVATED',
  UNDERPAID: 'UNDERPAID',
  INVOICE_NOT_PENDING: 'INVOICE_NOT_PENDING',
  UNMATCHED: 'UNMATCHED',
  NO_REFERENCE: 'NO_REFERENCE',
} as const;
export type PlatformTransferOutcome =
  (typeof PlatformTransferOutcome)[keyof typeof PlatformTransferOutcome];
const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Nửa đêm UTC của ngày chứa `date`. */
export function startOfDayUTC(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Số ngày nguyên giữa hai thời điểm, tính theo nửa đêm. */
export function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.round(
    (startOfDayUTC(later).getTime() - startOfDayUTC(earlier).getTime()) /
      DAY_MS,
  );
}

export function getBillingDays(
  billingCycle: string | null | undefined,
): number {
  return (
    (billingCycle ? BILLING_DAYS[billingCycle] : undefined) ??
    BILLING_DAYS.MONTHLY
  );
}

// Các cờ tính năng của gói.
export const PLAN_FEATURES = {
  STOCK_MOVEMENT: 'stock_movement',
  SALES: 'sales',
  REPORTS: 'reports',
  HR_MANAGEMENT: 'hr_management',
} as const;

export const VALID_PLAN_FEATURES: string[] = Object.values(PLAN_FEATURES);
