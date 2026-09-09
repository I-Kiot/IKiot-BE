/** Where a holiday row came from. Persisted values - add, never rename. */
export const HolidaySource = {
  GOOGLE_CALENDAR: 'GOOGLE_CALENDAR',
  MANUAL: 'MANUAL',
} as const;

export const HOLIDAY_SOURCES = Object.values(HolidaySource);

/** `PUBLIC_HOLIDAY` is the only type these routes touch; `COMPANY_HOLIDAY` exists in the schema for a per-branch closure feature that was never built. */
export const HolidayType = {
  PUBLIC_HOLIDAY: 'PUBLIC_HOLIDAY',
  COMPANY_HOLIDAY: 'COMPANY_HOLIDAY',
} as const;

/** A `YYYY-MM-DD` string as the UTC midnight a Postgres `date` column wants - the unique index, the sync's existence check and the year filter all have to agree on what midnight means. */
export function holidayDate(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`);
}

/** The half-open UTC range covering one calendar year, for the `year` filter. */
export function yearRange(year: number): { gte: Date; lt: Date } {
  return {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
