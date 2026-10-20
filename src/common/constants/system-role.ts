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

export const STAFF_BASE_PERMISSIONS: ReadonlySet<string> = new Set([
  'profile:read',
  'products:read',
  'categories:read',
  'brands:read',
  'schedules:read_own',
  'cash_drawers:read_own',
  // The branch / warehouse an employee is posted to (2026-10-07). Without it, a role with no `branches:read` had no branch to pick on the order form and the location switcher had no name to show - for the one place the account already works at.
  'branches:read_own',
  'warehouses:read_own',
]);
