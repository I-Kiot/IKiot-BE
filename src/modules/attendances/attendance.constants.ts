export const AttendanceStatus = {
  CHECKED_IN: 'CHECKED_IN',
  CHECKED_OUT: 'CHECKED_OUT',
  ABSENT: 'ABSENT',
} as const;

export const ATTENDANCE_STATUSES = Object.values(AttendanceStatus);

/** What a manager may write by hand. Same three the old DTO allowed. */
export const MANUAL_ATTENDANCE_STATUSES = ATTENDANCE_STATUSES;

/** How early somebody may clock in before their shift starts - a business rule, not a tolerance, since `workedMinutes` feeds payroll. */
export const ALLOWED_EARLY_CHECKIN_MINUTES = 30;

/** Payroll period statuses that freeze the attendance underneath them: from REVIEW on, the numbers have been read by a human and possibly paid out. */
export const ATTENDANCE_LOCKING_PERIOD_STATUSES = [
  'REVIEW',
  'APPROVED',
  'PAID',
];

/** Every period status that can cover a work date at all. */
export const OPEN_PERIOD_STATUSES = [
  'DRAFT',
  ...ATTENDANCE_LOCKING_PERIOD_STATUSES,
];
