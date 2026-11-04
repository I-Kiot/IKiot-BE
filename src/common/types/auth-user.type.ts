import { SystemRole } from '../constants/system-role';

/** Quyền tạm thời của người đang trực ca (`managedScheduleAccess` của iKiotMS-BE); null với người khác, và hết hạn theo đồng hồ. */
export interface ShiftSupervisorAccess {
  scheduleIds: string[];
  /** Địa điểm mà quyền giám sát chạm tới - giao giữa ca và chỗ làm của chính họ. */
  branchIds: string[];
  warehouseIds: string[];
  startsAt: Date;
  endsAt: Date;
}

/** JwtStrategy gắn vào `request.user` sau khi tra DB mới ở mỗi request, nên quyền phản ánh chỉnh sửa role hiện tại của tenant thay vì claim cache trong JWT. */
export interface AuthUser {
  userId: string;
  tenantId: string | null;
  systemRole: SystemRole;
  roleId: string | null;
  branchId: string | null;
  warehouseId: string | null;
  /** Nhân viên xưởng: WORKSHOP supplier mà tài khoản thuộc về (`users.workshop_id`). Null hoặc vắng với mọi người khác; JwtStrategy luôn set, user test tự dựng có thể bỏ qua. */
  workshopId?: string | null;
  /** Tập `"<resource>:<action>"`, rỗng với ADMIN/TENANT_OWNER (họ được bỏ qua kiểm tra); gồm cả quyền mà giám sát ca đang chạy thêm vào. */
  permissions: ReadonlySet<string>;
  /** Chỉ khác null khi tài khoản đang trực ca: `permissions` cho biết được làm gì, trường này cho biết ở đâu. */
  shiftSupervision: ShiftSupervisorAccess | null;
  /** Chỉ để AuditInterceptor không cần query thêm; không dùng trong kiểm tra quyền nào. */
  email: string | null;
  displayName: string | null;
  phoneNumber: string;
}
