import { CUSTOMER_PERMISSIONS, SystemRole } from '../constants/system-role';
import type { AuthUser } from '../types/auth-user.type';

/** Tài khoản có `resource:action` không? Quy tắc của guard, tách ra để service cũng hỏi được; ADMIN và TENANT_OWNER được bỏ qua. */
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
