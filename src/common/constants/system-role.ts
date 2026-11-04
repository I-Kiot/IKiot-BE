/** Loại tài khoản tổng quát. ADMIN và TENANT_OWNER luôn full quyền và không bao giờ là dòng trong Role; STAFF giữ một Role do tenant định nghĩa; CUSTOMER cố định và tối thiểu. */
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
  // Chi nhánh / kho được gán cho nhân viên. Thiếu quyền này, role không có chi nhánh để chọn trên form đơn và switcher không có tên để hiện.
  'branches:read_own',
  'warehouses:read_own',
  // Tìm và thêm khách. Ai bán hàng cũng cần cả hai; role thiếu một trong hai sẽ thấy trang khách trả 403. Sửa và xoá cấp riêng.
  'customers:read',
  'customers:create',
]);
