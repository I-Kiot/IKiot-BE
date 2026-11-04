import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  RequiredPermission,
} from '../decorators/permissions.decorator';
import type { AuthUser } from '../types/auth-user.type';
import { can } from '../utils/permission';
import { ErrorCode } from '../errors/error-codes';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<
      RequiredPermission | undefined
    >(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required) return true; // Route không khai báo @Permissions(...) - chỉ JwtAuthGuard chặn.

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user)
      throw new ForbiddenException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'No authenticated user on request',
      });

    // Chỉ cần một trong các action đã khai báo là đủ - xem ghi chú của @Permissions.
    const allowed = required.actions.some((action) =>
      can(user, required.resource, action),
    );
    if (!allowed) {
      const keys = required.actions
        .map((action) => `${required.resource}:${action}`)
        .join(' or ');
      throw new ForbiddenException({
        code: ErrorCode.PERMISSION_DENIED,
        message: `Missing permission ${keys}`,
      });
    }
    return true;
  }
}
