import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

export const CashDrawerStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
} as const;

export type CashDrawerStatus =
  (typeof CashDrawerStatus)[keyof typeof CashDrawerStatus];

export const CASH_DRAWER_STATUSES: readonly string[] =
  Object.values(CashDrawerStatus);

/** A shift log is written when a cashier takes the drawer (START) and hands it back (END). An END naming a `nextStaffId` is a handover; an END naming nobody is what makes the session finalizable. */
export const ShiftLogType = {
  START: 'START',
  END: 'END',
} as const;

export type ShiftLogType = (typeof ShiftLogType)[keyof typeof ShiftLogType];

export const SHIFT_LOG_TYPES: readonly string[] = Object.values(ShiftLogType);

/** Which day a drawer belongs to is a question about the shop's local calendar, not UTC - this alias only says what `VIETNAM_TIMEZONE` means here, since `businessDate` takes the zone as a parameter. */
export const BUSINESS_TIMEZONE = VIETNAM_TIMEZONE;
