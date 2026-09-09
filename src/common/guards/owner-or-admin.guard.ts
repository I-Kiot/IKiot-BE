import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../types/auth-user.type';
import { SystemRole } from '../constants/system-role';
import { ErrorCode } from '../errors/error-codes';

// Bypasses the Role/RolePermission catalog on purpose: role definitions must stay outside what a custom role could grant itself, so only ADMIN/TENANT_OWNER pass.
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
