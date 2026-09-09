import { BUSINESS_TIMEZONE } from './cash-drawer.constants';

/** Which trading day an instant belongs to, in the shop's timezone, returned as midnight UTC of that calendar day (the shape a Postgres `date` column wants). Doing it in UTC would file every drawer opened before 07:00 local under the previous day. */
export function businessDate(
  at: Date = new Date(),
  timeZone: string = BUSINESS_TIMEZONE,
): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return new Date(
    Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)),
  );
}

/** `YYYY-MM-DD`, for messages and for comparing two business dates in a log line. */
export function formatBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** How far the zone is ahead of UTC at a given instant, read off `Intl` rather than hardcoded - reconciliation is the one place where being an hour out silently moves a receipt into yesterday's till. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  // `hour12: false` renders local midnight as hour 24 in some ICU versions and 00 in others; only one of them survives Date.UTC unchanged.
  const hour = Number(value.hour) % 24;

  const asIfUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    hour,
    Number(value.minute),
    Number(value.second),
  );
  return asIfUtc - at.getTime();
}

/** The half-open UTC window `[start, end)` covering one trading day - the inverse of `businessDate()`, half-open so a receipt at exactly local midnight belongs to one day and is never double-counted. */
export function businessDayRange(
  day: Date,
  timeZone: string = BUSINESS_TIMEZONE,
): { start: Date; end: Date } {
  return {
    start: localMidnight(day, timeZone),
    end: localMidnight(new Date(day.getTime() + MS_PER_DAY), timeZone),
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The instant local midnight falls at for the day a UTC-midnight marker names. The offset is read twice - at the marker and again at the guess - because it is a property of the instant, so a DST day cannot land an hour off. */
function localMidnight(marker: Date, timeZone: string): Date {
  const guess = new Date(marker.getTime() - zoneOffsetMs(marker, timeZone));
  return new Date(marker.getTime() - zoneOffsetMs(guess, timeZone));
}
