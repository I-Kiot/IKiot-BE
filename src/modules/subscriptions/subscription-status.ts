import { addDays, GRACE_PERIOD_DAYS } from './subscription.constants';

/** The lifecycle a Subscription.status moves through. */
export const SubscriptionStatus = {
  TRIAL: 'TRIAL',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** Only the three fields the transition rules look at. */
export interface SubscriptionTerm {
  status: string;
  endDate: Date;
  trialEndDate: Date | null;
}

/** THE expiry rules, the single copy in the codebase: the status a subscription should be in at `now`. Applied lazily by `settleSubscription()` on every read and nightly by the cron. The two used to carry hand-written copies and had already drifted - never re-implement this at a call site. */
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
    // EXPIRED and CANCELLED are terminal - only a payment moves them, not the clock.
    return subscription.status;
  }

  // Past the grace period that follows the paid term: no longer recoverable.
  if (subscription.endDate < addDays(now, -GRACE_PERIOD_DAYS)) {
    return SubscriptionStatus.EXPIRED;
  }
  // Term is over but still inside the grace period: keep serving the tenant.
  if (now > subscription.endDate) return SubscriptionStatus.PAST_DUE;

  return subscription.status;
}
