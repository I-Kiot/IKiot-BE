import { DEFAULT_RANGE_DAYS, MS_PER_DAY, TZ_OFFSET } from './stats.constants';

/** The arithmetic behind every dashboard number, as pure functions - same shape and reason as `pricing-engine.ts`: these are the rules a shop owner will argue with. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  fromDate: Date;
  toDate: Date;
}

/** A bare `YYYY-MM-DD` means a whole local day, so which end of the range it is decides midnight or last millisecond; anything else goes to `Date` as-is and keeps its own offset. */
export function parseBoundary(raw: string, endOfDay: boolean): Date {
  if (DATE_ONLY.test(raw)) {
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
    return new Date(`${raw}T${time}${TZ_OFFSET}`);
  }
  return new Date(raw);
}

/** Defaults: ending now, starting 30 days earlier. */
export function resolveRange(rawFrom?: string, rawTo?: string): DateRange {
  const toDate = rawTo ? parseBoundary(rawTo, true) : new Date();
  const fromDate = rawFrom
    ? parseBoundary(rawFrom, false)
    : new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);
  return { fromDate, toDate };
}

/** The equal-length window immediately before the one asked for, which every `changePct` is measured against. Both windows are inclusive at both ends and touch without overlapping, so the `- 1`s are not decoration. */
export function previousPeriod({ fromDate, toDate }: DateRange): DateRange {
  const span = toDate.getTime() - fromDate.getTime();
  return {
    fromDate: new Date(fromDate.getTime() - span - 1),
    toDate: new Date(fromDate.getTime() - 1),
  };
}

/** Period-over-period change to one decimal place; `null` when the previous period was zero, since there is no honest percentage for "went from nothing to something" and 0 would read as flat. */
export function changePct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Average order value, rounded to whole đồng - VND has no minor unit. */
export function averageOrderValue(revenue: number, orderCount: number): number {
  return orderCount === 0 ? 0 : Math.round(revenue / orderCount);
}

/** A ratio as a percentage to one decimal, `null` when there is nothing to divide by. */
export function ratioPct(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/** `[{ status, count }]` → `{ status: count }`, the shape every summary block wants. */
export function countByKey<K extends string>(
  rows: { key: K | null; count: number }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    if (row.key === null) continue;
    out[row.key] = (out[row.key] ?? 0) + row.count;
  }
  return out;
}

export const COMPARISON_KEYS = [
  'today',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type ComparisonKey = (typeof COMPARISON_KEYS)[number];

export interface ComparisonWindow {
  key: ComparisonKey;
  current: DateRange;
  previous: DateRange;
}

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Midnight of a local (UTC+7) calendar day as an instant; `Date.UTC` normalises month/day overflow, so `m - 3` or `d - 7` need no special-casing. */
function localMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - TZ_OFFSET_MS);
}

/** Today, this week (Mon-start), month, quarter and year against the period before, in the shop's local calendar. The previous window is the *same elapsed span* of the previous period (1–15 Oct against 1–15 Sep), capped at that period's end, so a half-finished month is never judged against a whole one. */
export function comparisonWindows(now: Date): ComparisonWindow[] {
  const local = new Date(now.getTime() + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const quarterStart = Math.floor(m / 3) * 3;

  const starts: Record<ComparisonKey, [Date, Date]> = {
    today: [localMidnight(y, m, d), localMidnight(y, m, d - 1)],
    week: [
      localMidnight(y, m, d - sinceMonday),
      localMidnight(y, m, d - sinceMonday - 7),
    ],
    month: [localMidnight(y, m, 1), localMidnight(y, m - 1, 1)],
    quarter: [
      localMidnight(y, quarterStart, 1),
      localMidnight(y, quarterStart - 3, 1),
    ],
    year: [localMidnight(y, 0, 1), localMidnight(y - 1, 0, 1)],
  };

  return COMPARISON_KEYS.map((key) => {
    const [curFrom, prevFrom] = starts[key];
    const elapsed = now.getTime() - curFrom.getTime();
    const prevTo = Math.min(
      prevFrom.getTime() + elapsed,
      curFrom.getTime() - 1,
    );
    return {
      key,
      current: { fromDate: curFrom, toDate: now },
      previous: { fromDate: prevFrom, toDate: new Date(prevTo) },
    };
  });
}
