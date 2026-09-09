import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../constants/system-role';
import type { AuthUser } from '../types/auth-user.type';
import { ErrorCode } from '../errors/error-codes';

// The tenant is derived from the authenticated user, never taken from the client; ADMIN alone (no tenant of its own) may still name one explicitly.

/** Tenant filter for reads: `undefined` for an ADMIN who named no tenant, meaning every tenant; the caller's own tenant for everyone else. */
export function resolveTenantScope(
  user: AuthUser,
  requested?: string,
): string | undefined {
  if (user.systemRole === SystemRole.ADMIN) return requested;
  if (requested && requested !== user.tenantId) {
    throw new ForbiddenException({
      code: ErrorCode.TENANT_MISMATCH,
      message: 'Cannot access another tenant',
    });
  }
  if (!user.tenantId) {
    throw new ForbiddenException({
      code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
      message: 'Account is not attached to a tenant',
    });
  }
  return user.tenantId;
}

/** Tenant for writes - same rules, but "every tenant" is not a valid answer, so an ADMIN must name one. */
export function requireTenantId(user: AuthUser, requested?: string): string {
  const tenantId = resolveTenantScope(user, requested);
  if (!tenantId) {
    // Deliberately vague about how to name the tenant: only the generated CRUD routes accept `?tenantId=`.
    throw new BadRequestException({
      code: ErrorCode.TENANT_ID_REQUIRED,
      message:
        'ADMIN accounts belong to no tenant - this action must name one explicitly',
    });
  }
  return tenantId;
}
