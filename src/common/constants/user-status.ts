/** Vòng đời tài khoản. DELETED là xoá mềm (đặt cùng `User.deletedAt`), vì đơn, phiếu kho và audit log đang giữ FK. */
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  SUSPENDED: 'SUSPENDED',
  DELETED: 'DELETED',
} as const;

export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** Các trạng thái từ chối đăng nhập và vô hiệu token đã cấp - kiểm tra lúc đăng nhập và mọi request, nên đình chỉ sẽ khoá cả phiên đang chạy. */
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
