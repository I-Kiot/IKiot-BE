import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

export const CashDrawerStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;

export type CashDrawerStatus =
  (typeof CashDrawerStatus)[keyof typeof CashDrawerStatus];

export const CASH_DRAWER_STATUSES: readonly string[] =
  Object.values(CashDrawerStatus);

/** Loại sổ ca: START nhận két, END trả két. */
export const ShiftLogType = {
  START: 'START',
  END: 'END',
} as const;

export type ShiftLogType = (typeof ShiftLogType)[keyof typeof ShiftLogType];

export const SHIFT_LOG_TYPES: readonly string[] = Object.values(ShiftLogType);

/** Múi giờ dùng để tính ngày của két. */
export const BUSINESS_TIMEZONE = VIETNAM_TIMEZONE;
