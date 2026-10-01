import { shiftMinutes } from '../shift-templates/shift-time';

/** Turning "this shift template, on this date" into a real interval. A template's `08:00` means 08:00 in Vietnam, not on whatever clock the server runs - the old file hardcoded the +07:00 offset, which is correct for Vietnam (no DST since 1975) and wrong in general, and is kept because the alternative changes what every stored `startAt` means. */

/** Vietnam is UTC+7 year-round. */
const VN_OFFSET_MINUTES = 7 * 60;

/** A `Date` or `YYYY-MM-DD…` string → its `YYYY-MM-DD` part. */
export function localDateText(value: Date | string): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → the UTC midnight a Postgres `date` column stores. */
export function workDateOf(value: Date | string): Date {
  return new Date(`${localDateText(value)}T00:00:00.000Z`);
}

/** The actual instants a shift covers. A shift whose end time is earlier than its start runs past midnight - 22:00–06:00 is a night shift, not an error - which is why `ShiftTemplateDto` allows `endTime < startTime`; moving one rule without the other produces negative-length shifts. */
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

/** Sunday in Vietnam, read off the stored UTC-midnight work date. */
export function isSunday(workDate: Date | string): boolean {
  return workDateOf(workDate).getUTCDay() === 0;
}

/** What kind of day a shift falls on - shown on the roster. */
export function dayTypeOf(sunday: boolean, holiday: boolean): string {
  if (sunday && holiday) return 'SUNDAY_HOLIDAY';
  if (sunday) return 'SUNDAY';
  if (holiday) return 'HOLIDAY';
  return 'NORMAL';
}
