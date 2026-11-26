import {
  DEFAULT_RANGE_DAYS,
  MAX_HOURLY_RANGE_DAYS,
  MS_PER_DAY,
  STOCK_AGING_DAYS,
  StockAgingLevel,
  TZ_OFFSET,
} from './stats.constants';

/** Số học cho dashboard. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  fromDate: Date;
  toDate: Date;
}

/** Đổi `YYYY-MM-DD` thành đầu/cuối ngày theo giờ Việt Nam. */
export function parseBoundary(raw: string, endOfDay: boolean): Date {
  if (DATE_ONLY.test(raw)) {
    const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
    return new Date(`${raw}T${time}${TZ_OFFSET}`);
  }
  return new Date(raw);
}

export function resolveRange(rawFrom?: string, rawTo?: string): DateRange {
  const toDate = rawTo ? parseBoundary(rawTo, true) : new Date();
  const fromDate = rawFrom
    ? parseBoundary(rawFrom, false)
    : new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);
  return { fromDate, toDate };
}

/** Khoảng bằng nhau ngay trước khoảng được hỏi. */
export function previousPeriod({ fromDate, toDate }: DateRange): DateRange {
  const span = toDate.getTime() - fromDate.getTime();
  return {
    fromDate: new Date(fromDate.getTime() - span - 1),
    toDate: new Date(fromDate.getTime() - 1),
  };
}

/** % thay đổi so với kỳ trước; null khi kỳ trước bằng 0. */
export function changePct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Giá trị đơn trung bình, làm tròn đến đồng - VND không có đơn vị lẻ. */
export function averageOrderValue(revenue: number, orderCount: number): number {
  return orderCount === 0 ? 0 : Math.round(revenue / orderCount);
}

/** Tỉ lệ theo %, một chữ số thập phân; `null` khi mẫu bằng 0. */
export function ratioPct(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

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

/** Nửa đêm của một ngày theo giờ Việt Nam. */
function localMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - TZ_OFFSET_MS);
}

/** Các mốc hôm nay, tuần, tháng, quý, năm so với cùng khoảng kỳ trước. */
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

/** Mức cảnh báo theo số ngày chưa bán. */
export function stockAgingLevel(daysIdle: number): StockAgingLevel {
  if (daysIdle >= STOCK_AGING_DAYS[StockAgingLevel.STALE]) {
    return StockAgingLevel.STALE;
  }
  if (daysIdle >= STOCK_AGING_DAYS[StockAgingLevel.ATTENTION]) {
    return StockAgingLevel.ATTENTION;
  }
  if (daysIdle >= STOCK_AGING_DAYS[StockAgingLevel.WARNING]) {
    return StockAgingLevel.WARNING;
  }
  return StockAgingLevel.NORMAL;
}

/** Khoảng có dài quá N ngày không. */
export function exceedsHourlyRange({ fromDate, toDate }: DateRange): boolean {
  return (
    toDate.getTime() - fromDate.getTime() > MAX_HOURLY_RANGE_DAYS * MS_PER_DAY
  );
}

/** Khoảng ngày địa phương cho sổ doanh thu. */
export interface BusinessDateRange {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ngày lịch Việt Nam của một thời điểm. */
export function vietnamDateOf(at: Date): string {
  return new Date(at.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Khoảng thời điểm -> khoảng ngày địa phương chứa nó (đầu và cuối đều tính cả ngày). */
export function businessDatesOf({
  fromDate,
  toDate,
}: DateRange): BusinessDateRange {
  return { from: vietnamDateOf(fromDate), to: vietnamDateOf(toDate) };
}

/** Cùng số ngày ngay trước khoảng đã cho. */
export function previousBusinessDates({
  from,
  to,
}: BusinessDateRange): BusinessDateRange {
  const days =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        DAY_MS,
    ) + 1;
  const prevTo = shiftDate(from, -1);
  return { from: shiftDate(prevTo, -(days - 1)), to: prevTo };
}

/** Mọi mốc ngày/tháng trong khoảng, kể cả mốc không phát sinh. */
export function dateBuckets(
  { from, to }: BusinessDateRange,
  groupBy: 'day' | 'month',
): string[] {
  const buckets: string[] = [];
  if (groupBy === 'month') {
    let [y, m] = from.split('-').map(Number);
    const [endY, endM] = to.split('-').map(Number);
    while (y < endY || (y === endY && m <= endM)) {
      buckets.push(`${y}-${String(m).padStart(2, '0')}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return buckets;
  }
  for (let day = from; day <= to; day = shiftDate(day, 1)) buckets.push(day);
  return buckets;
}
