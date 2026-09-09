export const LeaveRequestStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  DELETED: 'DELETED',
} as const;

export const LEAVE_REQUEST_STATUSES = Object.values(LeaveRequestStatus);

/** Statuses that still hold a claim on the calendar and the leave balance - the pair that blocks an overlapping request and the only pair a cancellation can act on. */
export const LIVE_LEAVE_STATUSES = [
  LeaveRequestStatus.PENDING,
  LeaveRequestStatus.APPROVED,
];

/** What a reviewer may decide. */
export const REVIEW_DECISIONS = [
  LeaveRequestStatus.APPROVED,
  LeaveRequestStatus.REJECTED,
];

/** The annual allowance assumed when a balance was never set: 12 days, Vietnam's statutory minimum and what the old service defaulted to in three places. */
export const DEFAULT_ANNUAL_LEAVE_DAYS = 12;
