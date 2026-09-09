import {
  businessDate,
  businessDayRange,
  formatBusinessDate,
} from './business-date';

const iso = (at: string) => formatBusinessDate(businessDate(new Date(at)));

// Ho Chi Minh City is UTC+7 all year; getting this wrong puts an early-morning drawer onto the previous day's takings, which nobody notices until a till is short by a whole shift.
describe('businessDate', () => {
  it('uses the shop local day, not the UTC day', () => {
    // 17:30 UTC is already 00:30 the next morning in Vietnam.
    expect(iso('2026-08-26T17:30:00.000Z')).toBe('2026-08-27');
  });

  it('keeps late-evening local time on the same day', () => {
    // 16:59 UTC is 23:59 local - still the 26th.
    expect(iso('2026-08-26T16:59:00.000Z')).toBe('2026-08-26');
  });

  it('rolls over exactly at local midnight', () => {
    expect(iso('2026-08-26T16:59:59.999Z')).toBe('2026-08-26');
    expect(iso('2026-08-26T17:00:00.000Z')).toBe('2026-08-27');
  });

  it('handles a day that UTC has not started yet', () => {
    // 01:00 local on the 1st is 18:00 UTC on the previous month's last day.
    expect(iso('2026-08-31T18:00:00.000Z')).toBe('2026-09-01');
  });

  it('returns midnight UTC so a date column round-trips unchanged', () => {
    const value = businessDate(new Date('2026-08-26T09:15:00.000Z'));
    expect(value.toISOString()).toBe('2026-08-26T00:00:00.000Z');
  });

  it('honours a different timezone when one is given', () => {
    expect(
      formatBusinessDate(
        businessDate(new Date('2026-08-26T23:30:00.000Z'), 'UTC'),
      ),
    ).toBe('2026-08-26');
  });
});

// The inverse of businessDate, tested against it rather than hand-written offsets: what matters is that the two agree.
describe('businessDayRange', () => {
  const day = businessDate(new Date('2026-08-26T09:15:00.000Z'));

  it('starts at local midnight and runs exactly 24 hours', () => {
    const { start, end } = businessDayRange(day);
    expect(start.toISOString()).toBe('2026-08-25T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-26T17:00:00.000Z');
  });

  it('is the exact inverse of businessDate at both edges', () => {
    const { start, end } = businessDayRange(day);
    expect(businessDate(start).getTime()).toBe(day.getTime());
    expect(businessDate(new Date(start.getTime() - 1)).getTime()).toBeLessThan(
      day.getTime(),
    );
    // Half-open: `end` is already the next day's first instant.
    expect(businessDate(new Date(end.getTime() - 1)).getTime()).toBe(
      day.getTime(),
    );
    expect(businessDate(end).getTime()).toBeGreaterThan(day.getTime());
  });

  it('honours a different timezone when one is given', () => {
    const { start, end } = businessDayRange(day, 'UTC');
    expect(start.toISOString()).toBe('2026-08-26T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-27T00:00:00.000Z');
  });

  it('survives a daylight-saving transition', () => {
    // 2026-03-08 is when New York springs forward, so that local day is 23 hours long - Vietnam never does this, but the function is generic.
    const springForward = new Date(Date.UTC(2026, 2, 8));
    const { start, end } = businessDayRange(springForward, 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });
});
