import { SystemRole } from '../constants/system-role';

/** Quyền tạm thời của người đang trực ca, null với người khác. */
export interface ShiftSupervisorAccess {
  scheduleIds: string[];
  /** Địa điểm mà quyền giám sát chạm tới - giao giữa ca và chỗ làm của chính họ. */
  branchIds: string[];
  warehouseIds: string[];
  startsAt: Date;
  endsAt: Date;
}

/** User đã xác thực, quyền đọc lại từ DB ở mỗi request. */
export interface AuthUser {
  userId: string;
  tenantId: string | null;
  systemRole: SystemRole;
  roleId: string | null;
  branchId: string | null;
  warehouseId: string | null;
  /** Xưởng mà nhân viên xưởng thuộc về, null với người khác. */
  workshopId?: string | null;
  /** Tập quyền `resource:action`, rỗng với ADMIN/TENANT_OWNER, gồm cả quyền trực ca. */
  permissions: ReadonlySet<string>;
  /** Phạm vi trực ca, chỉ có khi đang trực. */
  shiftSupervision: ShiftSupervisorAccess | null;
  /** Chỉ để AuditInterceptor không cần query thêm; không dùng trong kiểm tra quyền nào. */
  email: string | null;
  displayName: string | null;
  /** Họ tên để hiển thị trong feed thay đổi. */
  fullName?: string | null;
  phoneNumber: string;
}
