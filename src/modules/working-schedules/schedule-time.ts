import { shiftMinutes } from '../shift-templates/shift-time';

/**
 * Đổi “mẫu ca này, vào ngày này” thành khoảng thời gian thật. `08:00` của mẫu là 08:00 giờ Việt Nam, không phải giờ máy chủ. Offset +07:00 cố định đúng cho VN (không DST từ 1975) nhưng sai nói chung; giữ lại vì đổi cách tính sẽ làm thay đổi ý nghĩa mọi `startAt` đã lưu.
 */
const VN_OFFSET_MINUTES = 7 * 60;

export function localDateText(value: Date | string): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

export function workDateOf(value: Date | string): Date {
  return new Date(`${localDateText(value)}T00:00:00.000Z`);
}

/** Ca có giờ kết thúc trước giờ bắt đầu là ca qua nửa đêm (22:00–06:00), không phải lỗi; vì vậy `ShiftTemplateDto` cho phép `endTime < startTime`. Đổi một quy tắc mà không đổi quy tắc kia sẽ ra ca có độ dài âm. */
export function shiftInterval(
  workDate: Date | string,
  template: { startTime: Date | null; endTime: Date | null },
): { startAt: Date; endAt: Date } {
  if (!template.startTime || !template.endTime) {
    throw new Error('Shift template is missing its start or end time');
  }

  const dateText = localDateText(workDate);
  const [year, month, day] = dateText.split('-').map(Number);
  const startMinutes = shiftMinutes(template.startTime);
  const endMinutes = shiftMinutes(template.endTime);

  const at = (minutes: number, dayOffset = 0) =>
    new Date(
      Date.UTC(year, month - 1, day + dayOffset, 0, minutes, 0, 0) -
        VN_OFFSET_MINUTES * 60 * 1000,
    );

  return {
    startAt: at(startMinutes),
    endAt: at(endMinutes, endMinutes < startMinutes ? 1 : 0),
  };
}

/** Đọc thứ bằng UTC vì ngày làm việc được lưu ở nửa đêm UTC. */
export function isSunday(workDate: Date | string): boolean {
  return workDateOf(workDate).getUTCDay() === 0;
}

export function dayTypeOf(sunday: boolean, holiday: boolean): string {
  if (sunday && holiday) return 'SUNDAY_HOLIDAY';
  if (sunday) return 'SUNDAY';
  if (holiday) return 'HOLIDAY';
  return 'NORMAL';
}
