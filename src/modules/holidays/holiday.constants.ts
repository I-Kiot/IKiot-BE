/** Nguồn gốc dòng ngày lễ. Giá trị đã lưu trong DB: chỉ thêm, không đổi tên. */
export const HolidaySource = {
  GOOGLE_CALENDAR: 'GOOGLE_CALENDAR',
  MANUAL: 'MANUAL',
} as const;

export const HOLIDAY_SOURCES = Object.values(HolidaySource);

/** Loại ngày lễ. */
export const HolidayType = {
  PUBLIC_HOLIDAY: 'PUBLIC_HOLIDAY',
  COMPANY_HOLIDAY: 'COMPANY_HOLIDAY',
} as const;

/** Đổi `YYYY-MM-DD` thành nửa đêm UTC. */
export function holidayDate(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`);
}

export function yearRange(year: number): { gte: Date; lt: Date } {
  return {
    gte: new Date(Date.UTC(year, 0, 1)),
    lt: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
