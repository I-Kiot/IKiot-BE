import { localDateText, workDateOf } from './schedule-time';

/**
 * Lịch lặp lại: một ca mẫu, từ ngày đến ngày, vào các thứ đã chọn. Hàm thuần.
 *
 * Chuỗi không được "đọc ảo" lúc xem lịch: khi tạo, mỗi ngày khớp được sinh thành một
 * WorkingSchedule như phân ca tay. Nhờ vậy ca hiện tại, quyền phụ trách ca, kiểm tra chồng
 * ca và gỡ một người khỏi một ngày đều chạy trên đúng một loại dữ liệu. Cái giá là giới hạn
 * độ dài, để một lần bấm không sinh hàng nghìn dòng.
 */
export const MAX_SERIES_DAYS = 366;

/** 0 = Chủ nhật … 6 = Thứ bảy, như `getUTCDay()`. */
export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export const SeriesStatus = {
  ACTIVE: 'ACTIVE',
  DELETED: 'DELETED',
} as const;

/** Bỏ trùng, sắp xếp; không gửi = mọi ngày. */
export function normalizeWeekdays(weekdays?: number[] | null): number[] {
  if (!weekdays || weekdays.length === 0) return [...ALL_WEEKDAYS];
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

/** Số ngày lịch của khoảng, tính cả hai đầu. */
export function seriesSpanDays(startDate: string, endDate: string): number {
  const ms = workDateOf(endDate).getTime() - workDateOf(startDate).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** Các ngày (YYYY-MM-DD) trong [startDate, endDate] rơi vào `weekdays`. */
export function seriesDates(
  startDate: string,
  endDate: string,
  weekdays: number[],
): string[] {
  const wanted = new Set(weekdays);
  const dates: string[] = [];
  const cursor = workDateOf(startDate);
  const last = workDateOf(endDate);
  while (cursor <= last) {
    if (wanted.has(cursor.getUTCDay())) dates.push(localDateText(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Ngày liền trước (YYYY-MM-DD). */
export function previousDate(date: string): string {
  const day = workDateOf(date);
  day.setUTCDate(day.getUTCDate() - 1);
  return localDateText(day);
}
