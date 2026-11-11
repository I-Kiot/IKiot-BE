import {
  DEFAULT_RANGE_DAYS,
  MAX_HOURLY_RANGE_DAYS,
  MS_PER_DAY,
  STOCK_AGING_DAYS,
  StockAgingLevel,
  TZ_OFFSET,
} from './stats.constants';

/** Số học đằng sau mọi con số dashboard, viết dạng hàm thuần (cùng cách với `pricing-engine.ts`) vì đây là các quy tắc chủ shop hay tranh cãi. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  fromDate: Date;
  toDate: Date;
}

/** `YYYY-MM-DD` trơn là cả ngày địa phương: đầu khoảng thành 00:00, cuối khoảng thành 23:59:59.999. Chuỗi khác đưa thẳng cho `Date` và giữ offset của nó. */
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

/** Khoảng bằng nhau ngay trước khoảng được hỏi, là mốc cho mọi `changePct`. Hai khoảng đều bao cả hai đầu và liền kề không chồng nhau, nên các `- 1` là cần thiết. */
export function previousPeriod({ fromDate, toDate }: DateRange): DateRange {
  const span = toDate.getTime() - fromDate.getTime();
  return {
    fromDate: new Date(fromDate.getTime() - span - 1),
    toDate: new Date(fromDate.getTime() - 1),
  };
}

/** % thay đổi so với kỳ trước, một chữ số thập phân; `null` khi kỳ trước bằng 0, vì "từ không lên có" không có % trung thực, còn 0 sẽ bị đọc là đi ngang. */
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

/** Nửa đêm của ngày lịch địa phương (UTC+7) dưới dạng thời điểm. `Date.UTC` tự chuẩn hoá tràn tháng/ngày nên `m - 3` hay `d - 7` không cần xử lý riêng. */
function localMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d) - TZ_OFFSET_MS);
}

/** Hôm nay, tuần này (bắt đầu thứ Hai), tháng, quý, năm so với kỳ trước, theo lịch địa phương. Kỳ trước lấy đúng *khoảng thời gian đã trôi qua* (1–15/10 so với 1–15/9), không vượt cuối kỳ đó, nên tháng đang dở không bị so với tháng đủ. */
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

/** Xếp một dòng tồn vào mức cảnh báo theo số ngày chưa bán: dưới 30 bình thường, 30–59 cảnh báo, 60–89 cần chú ý, từ 90 tồn lâu ngày. Ngưỡng nằm ở `STOCK_AGING_DAYS`; phần đếm trong SQL (`getStockAlerts`) đọc cùng hằng số đó, còn mức của từng dòng do hàm này gán. */
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

/** Khoảng thời gian có quá dài để chia theo giờ không. So bằng mili-giây là đủ ở đây: câu hỏi là "có vượt N ngày không", không phải đếm ngày lịch. */
export function exceedsHourlyRange({ fromDate, toDate }: DateRange): boolean {
  return (
    toDate.getTime() - fromDate.getTime() > MAX_HOURLY_RANGE_DAYS * MS_PER_DAY
  );
}

/** Khoảng ngày địa phương (`YYYY-MM-DD`, gồm cả hai đầu) - đơn vị của sổ doanh thu: bút toán chỉ có `business_date`, không có giờ để cắt giữa ngày. */
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

/** Cùng số ngày liền ngay trước khoảng đã cho, không chồng lên nó (khác `previousPeriod`, cắt theo mili-giây và có thể rơi vào cùng một ngày với đầu kỳ này). */
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
