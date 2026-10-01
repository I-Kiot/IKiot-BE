/** User account lifecycle. DELETED is a soft delete (`User.deletedAt` set alongside), since orders, attendances, audit logs and payslips hold FKs. */
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** Statuses that refuse a login and invalidate an issued token - checked at login and on every request, so suspending locks out a running session. */
export const INACTIVE_USER_STATUSES: ReadonlySet<string> = new Set([
  UserStatus.SUSPENDED,
  UserStatus.INACTIVE,
  UserStatus.DELETED,
]);

/** What a client may set directly on a user - DELETED is reachable only via DELETE. */
export const SETTABLE_USER_STATUSES: readonly string[] = [
  UserStatus.ACTIVE,
  UserStatus.INACTIVE,
  UserStatus.SUSPENDED,
];
