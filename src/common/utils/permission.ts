import { CUSTOMER_PERMISSIONS, SystemRole } from '../constants/system-role';
import type { AuthUser } from '../types/auth-user.type';

/** Does this account hold `resource:action`? The guard's rule, extracted so a service can ask it too; ADMIN and TENANT_OWNER short-circuit. */
export function can(user: AuthUser, resource: string, action: string): boolean {
  if (
    user.systemRole === SystemRole.ADMIN ||
    user.systemRole === SystemRole.TENANT_OWNER
  ) {
    return true;
  }

  const key = `${resource}:${action}`;
  return user.systemRole === SystemRole.CUSTOMER
    ? CUSTOMER_PERMISSIONS.has(key)
    : user.permissions.has(key);
}
