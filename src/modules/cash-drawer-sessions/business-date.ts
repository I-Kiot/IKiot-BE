import { BUSINESS_TIMEZONE } from './cash-drawer.constants';

/** Ngày giao dịch của một thời điểm theo múi giờ shop, trả về nửa đêm UTC của ngày đó (cột `date` của Postgres cần). Tính theo UTC sẽ đẩy mọi két mở trước 07:00 giờ địa phương sang ngày hôm trước. */
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

/** `YYYY-MM-DD`, dùng cho thông báo và so sánh hai ngày giao dịch trong log. */
export function formatBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Múi giờ lệch UTC bao nhiêu tại một thời điểm, đọc từ `Intl` chứ không hard-code - đối chiếu là chỗ duy nhất mà lệch một giờ sẽ âm thầm chuyển biên lai sang két hôm qua. */
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

  // `hour12: false` có bản ICU trả nửa đêm là giờ 24, bản khác trả 00; chỉ một dạng đi qua Date.UTC nguyên vẹn.
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

/** Khoảng UTC nửa mở `[start, end)` của một ngày giao dịch, nghịch đảo của `businessDate()`. Nửa mở để biên lai đúng nửa đêm địa phương thuộc đúng một ngày, không bị đếm hai lần. */
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

/** Nửa đêm địa phương của ngày mà marker nửa đêm UTC trỏ tới. Offset đọc hai lần (tại marker và tại điểm đoán) vì nó phụ thuộc thời điểm, để ngày đổi giờ không lệch một giờ. */
function localMidnight(marker: Date, timeZone: string): Date {
  const guess = new Date(marker.getTime() - zoneOffsetMs(marker, timeZone));
  return new Date(marker.getTime() - zoneOffsetMs(guess, timeZone));
}
