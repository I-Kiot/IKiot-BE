/** Leave is counted in whole calendar days, so every date here is UTC midnight. Deliberately separate from `working-schedules/schedule-time.ts`: a shift starts at a wall-clock hour, but applying an offset to a leave day would make a one-day leave span two dates. */
export function leaveDate(value: Date | string): Date {
  const text =
    typeof value === 'string'
      ? value.slice(0, 10)
      : value.toISOString().slice(0, 10);
  return new Date(`${text}T00:00:00.000Z`);
}

/** The day after - an exclusive upper bound for a range query. */
export function nextDay(value: Date): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** Whole days from start to end, both ends inclusive - one day off is 1, not 0, and that is what `paidLeaveDays + unpaidLeaveDays` is checked against. */
export function leaveDayCount(start: Date, end: Date): number {
  const from = leaveDate(start);
  const to = leaveDate(end);
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
}
