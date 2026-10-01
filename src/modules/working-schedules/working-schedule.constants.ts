/** NORMAL is a rostered shift; OVERTIME is extra time and is never counted as "late". */
export const ScheduleType = {
  NORMAL: 'NORMAL',
  OVERTIME: 'OVERTIME',
} as const;

export const SCHEDULE_TYPES = Object.values(ScheduleType);

export const ScheduleStatus = {
  SCHEDULED: 'SCHEDULED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DELETED: 'DELETED',
} as const;

/** What a client may filter by - DELETED is not a state anyone asks to see. */
export const FILTERABLE_SCHEDULE_STATUSES = [
  ScheduleStatus.SCHEDULED,
  ScheduleStatus.COMPLETED,
  ScheduleStatus.CANCELLED,
];

/** Statuses that still occupy a person's time; a CANCELLED or DELETED shift clashes with nothing, which is what makes rescheduling after a cancellation possible. */
export const LIVE_SCHEDULE_STATUSES = [
  ScheduleStatus.SCHEDULED,
  ScheduleStatus.COMPLETED,
];

/** The fallback when a tenant has no PayrollSetting yet - the old service's default. */
export const DEFAULT_LATE_GRACE_MINUTES = 15;
