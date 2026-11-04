import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../types/auth-user.type';
import { SystemRole } from '../constants/system-role';
import { ErrorCode } from '../errors/error-codes';

// Cố ý bỏ qua danh mục Role/RolePermission: định nghĩa role phải nằm ngoài những gì một role tuỳ biến có thể tự cấp cho mình, nên chỉ ADMIN/TENANT_OWNER qua.
@Injectable()
export class OwnerOrAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (
      !user ||
      (user.systemRole !== SystemRole.TENANT_OWNER &&
        user.systemRole !== SystemRole.ADMIN)
    ) {
      throw new ForbiddenException({
        code: ErrorCode.TENANT_OWNER_ONLY,
        message: 'Only the tenant owner can do this',
      });
    }
    return true;
  }
}
