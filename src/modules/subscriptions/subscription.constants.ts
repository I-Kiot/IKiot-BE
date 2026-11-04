// Port từ src/constants/subscription.js của iKiotMS-BE.
export const GRACE_PERIOD_DAYS = 3;
export const REMINDER_DAYS = [7, 3, 1];
export const BILLING_DAYS: Record<string, number> = {
  MONTHLY: 30,
  YEARLY: 365,
};
export const QR_EXPIRY_MS = 15 * 60 * 1000;
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

/** Số ngày nguyên giữa hai thời điểm, tính theo nửa đêm để kết quả không phụ thuộc giờ request đến (chia mili-giây từng báo 10 hoặc 11 ngày cho cùng một gói). Âm khi `later` trước `earlier`. */
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

// Port từ planFeatures.js: tập cờ cố định mà một phần tử `Plan.features[]` được chứa; UpdatePlanDto kiểm tra theo tập này.
export const PLAN_FEATURES = {
  STOCK_MOVEMENT: 'stock_movement',
  SALES: 'sales',
  REPORTS: 'reports',
  HR_MANAGEMENT: 'hr_management',
} as const;

export const VALID_PLAN_FEATURES: string[] = Object.values(PLAN_FEATURES);
