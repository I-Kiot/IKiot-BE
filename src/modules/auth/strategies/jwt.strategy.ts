import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../../common/types/auth-user.type';
import {
  STAFF_BASE_PERMISSIONS,
  SystemRole,
  WORKSHOP_STAFF_PERMISSIONS,
} from '../../../common/constants/system-role';
import { INACTIVE_USER_STATUSES } from '../../../common/constants/user-status';
import { ShiftSupervisorService } from '../../working-schedules/shift-supervisor.service';
import { accessTokenSecret } from '../../../common/config/env';
import { personName } from '../../../common/utils/user-profile';
import { ErrorCode } from '../../../common/errors/error-codes';
import {
  LOCATION_TYPE_SELECT,
  columnsOfLocation,
} from '../../../common/dto/location-ref.dto';

interface JwtPayload {
  sub: string;
  /** Loại token chuyên dụng; access token không có. */
  type?: string;
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

  // Đọc lại user và quyền ở mỗi request.
  async validate(payload: JwtPayload): Promise<AuthUser> {
    // Không chấp nhận token OTP / reset làm access token.
    if (payload.type !== undefined)
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'Invalid access token',
      });
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        role: { include: { permissions: true } },
        location: LOCATION_TYPE_SELECT,
      },
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

    // Tách nơi làm việc thành chi nhánh/kho.
    const { branchId, warehouseId } = columnsOfLocation(user.location);

    // Thêm quyền trưởng ca đang trực, tính lại mỗi request.
    const supervision = await this.shiftSupervisor.resolve({
      userId: user.id,
      tenantId: user.tenantId,
      systemRole: user.systemRole,
      branchId,
      warehouseId,
      status: user.status,
    });

    return {
      userId: user.id,
      tenantId: user.tenantId,
      systemRole: user.systemRole as SystemRole,
      roleId: user.roleId,
      branchId,
      warehouseId,
      workshopId: user.workshopId,
      permissions: new Set([
        ...(user.systemRole === SystemRole.STAFF ? STAFF_BASE_PERMISSIONS : []),
        ...(user.systemRole === SystemRole.STAFF && user.workshopId
          ? WORKSHOP_STAFF_PERMISSIONS
          : []),
        ...(user.role?.permissions.map((p) => `${p.resource}:${p.action}`) ??
          []),
        ...ShiftSupervisorService.keysFor(supervision),
      ]),
      shiftSupervision: supervision,
      email: user.email,
      displayName: user.profileFirstName
        ? `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim()
        : null,
      fullName: personName(user),
      phoneNumber: user.phoneNumber,
    };
  }
}
