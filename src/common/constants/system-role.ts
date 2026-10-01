/** Coarse account kind. ADMIN and TENANT_OWNER are always full-access and never rows in Role; STAFF holds a tenant-defined Role; CUSTOMER is fixed and minimal. */
export const SystemRole = {
  ADMIN: 'ADMIN',
  TENANT_OWNER: 'TENANT_OWNER',
  CUSTOMER: 'CUSTOMER',
  STAFF: 'STAFF',
} as const;

export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

/** Fixed, hardcoded grants for CUSTOMER accounts - never routed through Role/RolePermission. */
export const CUSTOMER_PERMISSIONS: ReadonlySet<string> = new Set([
  'profile:read',
]);
