import {
  nextSubscriptionStatus,
  SubscriptionStatus,
} from './subscription-status';
import {
  addDays,
  GRACE_PERIOD_DAYS,
  wholeDaysBetween,
} from './subscription.constants';

const NOW = new Date('2026-08-20T09:30:00.000Z');

function term(overrides: {
  status: string;
  endDate?: Date;
  trialEndDate?: Date | null;
}) {
  return {
    status: overrides.status,
    endDate: overrides.endDate ?? addDays(NOW, 10),
    trialEndDate: overrides.trialEndDate ?? null,
  };
}

// These rules used to exist twice - lazily in the service, in bulk in the cron - and had already drifted apart, so the one function they became is worth pinning down.
describe('nextSubscriptionStatus', () => {
  it('leaves a trial alone until its end date passes', () => {
    expect(
      nextSubscriptionStatus(
        term({
          status: SubscriptionStatus.TRIAL,
          trialEndDate: addDays(NOW, 1),
        }),
        NOW,
      ),
    ).toBe(SubscriptionStatus.TRIAL);
  });

  it('expires a trial once its end date passes', () => {
    expect(
      nextSubscriptionStatus(
        term({
          status: SubscriptionStatus.TRIAL,
          trialEndDate: addDays(NOW, -1),
        }),
        NOW,
      ),
    ).toBe(SubscriptionStatus.EXPIRED);
  });

  it('moves an ended paid term to PAST_DUE inside the grace period', () => {
    expect(
      nextSubscriptionStatus(
        term({ status: SubscriptionStatus.ACTIVE, endDate: addDays(NOW, -1) }),
        NOW,
      ),
    ).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('expires a term that is past the grace period', () => {
    expect(
      nextSubscriptionStatus(
        term({
          status: SubscriptionStatus.PAST_DUE,
          endDate: addDays(NOW, -(GRACE_PERIOD_DAYS + 1)),
        }),
        NOW,
      ),
    ).toBe(SubscriptionStatus.EXPIRED);
  });

  it('never resurrects a terminal status', () => {
    for (const status of [
      SubscriptionStatus.EXPIRED,
      SubscriptionStatus.CANCELLED,
    ]) {
      expect(
        nextSubscriptionStatus(
          term({ status, endDate: addDays(NOW, 30) }),
          NOW,
        ),
      ).toBe(status);
    }
  });
});

describe('wholeDaysBetween', () => {
  it('does not depend on the time of day it is called', () => {
    const endDate = new Date('2026-08-30T00:00:00.000Z');
    const earlyMorning = new Date('2026-08-20T00:05:00.000Z');
    const lateEvening = new Date('2026-08-20T23:55:00.000Z');

    expect(wholeDaysBetween(earlyMorning, endDate)).toBe(10);
    expect(wholeDaysBetween(lateEvening, endDate)).toBe(10);
  });

  it('counts backwards as a negative number', () => {
    expect(
      wholeDaysBetween(
        new Date('2026-08-20T00:00:00.000Z'),
        new Date('2026-08-17T00:00:00.000Z'),
      ),
    ).toBe(-3);
  });
});
