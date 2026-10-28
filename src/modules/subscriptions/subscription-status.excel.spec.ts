import { nextSubscriptionStatus } from './subscription-status';

// Excel sheet "Subscriptions" - nextSubscriptionStatus (UTC001-UTC010).
describe('nextSubscriptionStatus (Excel UTC)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const run = (
    status: string,
    now: string,
    endDate: string,
    trialEndDate: string | null = null,
  ) =>
    nextSubscriptionStatus(
      {
        status,
        endDate: d(endDate),
        trialEndDate: trialEndDate ? d(trialEndDate) : null,
      },
      d(now),
    );

  it('UTC001: trial still running', () => {
    expect(run('TRIAL', '2026-01-15', '2026-02-01', '2026-02-01')).toBe(
      'TRIAL',
    );
  });
  it('UTC002: trial on its last day stays TRIAL', () => {
    expect(run('TRIAL', '2026-02-01', '2026-02-01', '2026-02-01')).toBe(
      'TRIAL',
    );
  });
  it('UTC003: trial past end becomes EXPIRED', () => {
    expect(run('TRIAL', '2026-02-02', '2026-02-01', '2026-02-01')).toBe(
      'EXPIRED',
    );
  });
  it('UTC004: trial without end date stays TRIAL', () => {
    expect(run('TRIAL', '2027-01-01', '2026-02-01', null)).toBe('TRIAL');
  });
  it('UTC005: EXPIRED is terminal', () => {
    expect(run('EXPIRED', '2026-10-25', '2025-01-01')).toBe('EXPIRED');
  });
  it('UTC006: CANCELLED is terminal', () => {
    expect(run('CANCELLED', '2026-10-25', '2025-01-01')).toBe('CANCELLED');
  });
  it('UTC007: ACTIVE past the grace period becomes EXPIRED', () => {
    expect(run('ACTIVE', '2026-01-05', '2026-01-01')).toBe('EXPIRED');
  });
  it('UTC008: ACTIVE inside the grace period becomes PAST_DUE', () => {
    expect(run('ACTIVE', '2026-01-04', '2026-01-01')).toBe('PAST_DUE');
  });
  it('UTC009: ACTIVE on its end date stays ACTIVE', () => {
    expect(run('ACTIVE', '2026-01-10', '2026-01-10')).toBe('ACTIVE');
  });
  it('UTC010: PAST_DUE inside the grace period stays PAST_DUE', () => {
    expect(run('PAST_DUE', '2026-01-02', '2026-01-01')).toBe('PAST_DUE');
  });
});
