/** `startTime` / `endTime` là cột `@db.Time` nhưng API dùng `HH:mm`; file này là nơi duy nhất chuyển đổi. Prisma trả Date ngày 1970-01-01 theo UTC, nên mọi thứ ở đây cố ý dùng UTC: `getHours()` sẽ biến ca 08:00 thành 15:00 ở VN. */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SHIFT_TIME_MESSAGE = 'Giờ phải có định dạng HH:mm';

export function isShiftTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function toShiftTime(text: string): Date {
  const [hour, minute] = text.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0, 0));
}

export function fromShiftTime(value: Date | null): string | null {
  if (!value) return null;
  const hour = String(value.getUTCHours()).padStart(2, '0');
  const minute = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

/** Số phút từ nửa đêm, để so giờ bắt đầu với giờ kết thúc không qua chuỗi (code cũ từng dựa vào so sánh chữ `"22:00" > "06:00"`). */
export function shiftMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}
