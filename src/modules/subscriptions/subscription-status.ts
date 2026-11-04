import { addDays, GRACE_PERIOD_DAYS } from './subscription.constants';

export const SubscriptionStatus = {
  TRIAL: 'TRIAL',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

export interface SubscriptionTerm {
  status: string;
  endDate: Date;
  trialEndDate: Date | null;
}

/** Quy tắc hết hạn DUY NHẤT trong codebase: trạng thái gói phải có tại `now`. Áp dụng lười bởi `settleSubscription()` mỗi lần đọc, và cron chạy hằng đêm. Hai bản viết tay trước đây đã lệch nhau: không viết lại ở chỗ gọi. */
export function nextSubscriptionStatus(
  subscription: SubscriptionTerm,
  now: Date,
): string {
  if (subscription.status === SubscriptionStatus.TRIAL) {
    const trialIsOver =
      subscription.trialEndDate !== null && now > subscription.trialEndDate;
    return trialIsOver ? SubscriptionStatus.EXPIRED : SubscriptionStatus.TRIAL;
  }

  if (
    subscription.status !== SubscriptionStatus.ACTIVE &&
    subscription.status !== SubscriptionStatus.PAST_DUE
  ) {
    // EXPIRED và CANCELLED là trạng thái cuối: chỉ thanh toán mới đổi được, đồng hồ thì không.
    return subscription.status;
  }

  // Đã qua thời gian ân hạn sau kỳ trả phí: không còn khôi phục được.
  if (subscription.endDate < addDays(now, -GRACE_PERIOD_DAYS)) {
    return SubscriptionStatus.EXPIRED;
  }
  // Hết kỳ nhưng còn trong thời gian ân hạn: vẫn phục vụ shop.
  if (now > subscription.endDate) return SubscriptionStatus.PAST_DUE;

  return subscription.status;
}
