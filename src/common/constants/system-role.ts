/** Loại tài khoản: ADMIN và TENANT_OWNER full quyền, STAFF theo role, CUSTOMER tối thiểu. */
export const SystemRole = {
  ADMIN: 'ADMIN',
  TENANT_OWNER: 'TENANT_OWNER',
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

/** Quyền cố định, gắn cứng cho tài khoản CUSTOMER - không đi qua Role/RolePermission. */
export const CUSTOMER_PERMISSIONS: ReadonlySet<string> = new Set([
  'profile:read',
]);

export const STAFF_BASE_PERMISSIONS: ReadonlySet<string> = new Set([
  'profile:read',
  'products:read',
  'categories:read',
  'brands:read',
  'schedules:read_own',
  'cash_drawers:read_own',
  // Đọc chi nhánh / kho được gán, cần cho form đơn và bộ chọn địa điểm.
  'branches:read_own',
  'warehouses:read_own',
  // Tìm và thêm khách, ai bán hàng cũng cần.
  'customers:read',
  'customers:create',
]);

/** Quyền tự cấp cho nhân viên gắn xưởng, không qua role. */
export const WORKSHOP_STAFF_PERMISSIONS: ReadonlySet<string> = new Set([
  'production:deliver',
]);

/** Quyền tự cấp theo loại tài khoản: màn Vai trò không hiện, role không lưu được. */
export const AUTO_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  ...STAFF_BASE_PERMISSIONS,
  ...WORKSHOP_STAFF_PERMISSIONS,
]);
