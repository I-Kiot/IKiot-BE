import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../types/auth-user.type';
import { SystemRole } from '../constants/system-role';
import { ErrorCode } from '../errors/error-codes';

// Chỉ ADMIN / TENANT_OWNER được qua, bỏ qua quyền theo role.
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
