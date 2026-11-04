import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../constants/system-role';
import type { AuthUser } from '../types/auth-user.type';
import { ErrorCode } from '../errors/error-codes';

// Tenant luôn suy ra từ user đã xác thực, không lấy từ client; chỉ ADMIN (không có tenant riêng) mới được nêu tenant tường minh.

/** Filter tenant cho đọc: `undefined` với ADMIN không nêu tenant, nghĩa là mọi tenant; với người khác là tenant của chính họ. */
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

/** Tenant cho ghi - cùng quy tắc, nhưng "mọi tenant" không hợp lệ, nên ADMIN phải nêu một tenant. */
export function requireTenantId(user: AuthUser, requested?: string): string {
  const tenantId = resolveTenantScope(user, requested);
  if (!tenantId) {
    // Cố ý mơ hồ về cách nêu tenant: chỉ các route CRUD tự sinh mới nhận `?tenantId=`.
    throw new BadRequestException({
      code: ErrorCode.TENANT_ID_REQUIRED,
      message:
        'ADMIN accounts belong to no tenant - this action must name one explicitly',
    });
  }
  return tenantId;
}
