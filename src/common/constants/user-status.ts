/** Trạng thái tài khoản; DELETED là xoá mềm. */
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** Trạng thái bị chặn đăng nhập và vô hiệu token đang dùng. */
export const INACTIVE_USER_STATUSES: ReadonlySet<string> = new Set([
  UserStatus.SUSPENDED,
  UserStatus.INACTIVE,
  UserStatus.DELETED,
]);

/** Trạng thái client được đặt trực tiếp cho user - DELETED chỉ qua DELETE. */
export const SETTABLE_USER_STATUSES: readonly string[] = [
  UserStatus.ACTIVE,
  UserStatus.INACTIVE,
  UserStatus.SUSPENDED,
];
