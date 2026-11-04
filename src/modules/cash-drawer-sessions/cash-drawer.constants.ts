import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

export const CashDrawerStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;

export type CashDrawerStatus =
  (typeof CashDrawerStatus)[keyof typeof CashDrawerStatus];

export const CASH_DRAWER_STATUSES: readonly string[] =
  Object.values(CashDrawerStatus);

/** Sổ ca được ghi khi thu ngân nhận két (START) và trả lại (END). END có `nextStaffId` là bàn giao; END không có ai là thứ khiến session chốt được. */
export const ShiftLogType = {
  START: 'START',
  END: 'END',
} as const;

export type ShiftLogType = (typeof ShiftLogType)[keyof typeof ShiftLogType];

export const SHIFT_LOG_TYPES: readonly string[] = Object.values(ShiftLogType);

/** Két thuộc ngày nào là câu hỏi theo lịch địa phương của shop, không phải UTC. Alias này chỉ cho biết `VIETNAM_TIMEZONE` nghĩa là gì ở đây, vì `businessDate` nhận múi giờ làm tham số. */
export const BUSINESS_TIMEZONE = VIETNAM_TIMEZONE;
