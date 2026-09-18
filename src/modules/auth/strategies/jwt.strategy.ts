import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../../common/types/auth-user.type';
import {
  STAFF_BASE_PERMISSIONS,
  SystemRole,
} from '../../../common/constants/system-role';
import { INACTIVE_USER_STATUSES } from '../../../common/constants/user-status';
import { ShiftSupervisorService } from '../../working-schedules/shift-supervisor.service';
import { accessTokenSecret } from '../../../common/config/env';
import { ErrorCode } from '../../../common/errors/error-codes';

interface JwtPayload {
  sub: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shiftSupervisor: ShiftSupervisorService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: accessTokenSecret(),
    });
  }

  // Re-fetches the user and their current Role grants on every request rather than trusting cached JWT claims: with tenant-editable roles, a revoked permission must take effect immediately.
  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { role: { include: { permissions: true } } },
    });

    if (!user)
      throw new UnauthorizedException({
        code: ErrorCode.USER_NOT_FOUND,
        message: 'User not found',
      });
    if (INACTIVE_USER_STATUSES.has(user.status))
      throw new UnauthorizedException({
        code: ErrorCode.ACCOUNT_INACTIVE,
        message: 'Account is not active',
      });

    // Whoever is running a shift right now holds a fixed extra set of permissions for as long as it runs - resolved per request so a shift that ended two minutes ago grants nothing.
    const supervision = await this.shiftSupervisor.resolve({
      userId: user.id,
      tenantId: user.tenantId,
      systemRole: user.systemRole,
      branchId: user.branchId,
      warehouseId: user.warehouseId,
      status: user.status,
    });

    return {
      userId: user.id,
      tenantId: user.tenantId,
      systemRole: user.systemRole as SystemRole,
      roleId: user.roleId,
      branchId: user.branchId,
      warehouseId: user.warehouseId,
      permissions: new Set([
        ...(user.systemRole === SystemRole.STAFF ? STAFF_BASE_PERMISSIONS : []),
        ...(user.role?.permissions.map((p) => `${p.resource}:${p.action}`) ??
          []),
        ...ShiftSupervisorService.keysFor(supervision),
      ]),
      shiftSupervision: supervision,
      email: user.email,
      displayName: user.profileFirstName
        ? `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim()
        : null,
      phoneNumber: user.phoneNumber,
    };
  }
}
