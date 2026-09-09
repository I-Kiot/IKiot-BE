import { SystemRole } from '../constants/system-role';

/** Temporary rights held by whoever is running a shift right now (iKiotMS-BE's `managedScheduleAccess`); null for everyone else, and it expires by the clock. */
export interface ShiftSupervisorAccess {
  scheduleIds: string[];
  /** Locations the supervision reaches - the shift's, intersected with their own posting. */
  branchIds: string[];
  warehouseIds: string[];
  startsAt: Date;
  endsAt: Date;
}

/** Populated onto `request.user` by JwtStrategy after a fresh per-request DB lookup, so permissions reflect the tenant's current role edits rather than cached JWT claims. */
export interface AuthUser {
  userId: string;
  tenantId: string | null;
  systemRole: SystemRole;
  roleId: string | null;
  branchId: string | null;
  warehouseId: string | null;
  /** `"<resource>:<action>"` set, empty for ADMIN/TENANT_OWNER (they short-circuit); includes anything a live shift supervision adds. */
  permissions: ReadonlySet<string>;
  /** Non-null only while this account is running a shift: `permissions` says what it allows, this says where. */
  shiftSupervision: ShiftSupervisorAccess | null;
  /** Carried only so AuditInterceptor needs no second query; not used by any permission check. */
  email: string | null;
  displayName: string | null;
  phoneNumber: string;
}
