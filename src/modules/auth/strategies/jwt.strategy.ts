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
import {
  LOCATION_TYPE_SELECT,
  columnsOfLocation,
} from '../../../common/dto/location-ref.dto';

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

  // Đọc lại user và quyền Role ở mỗi request, không tin claim đã cache trong JWT: role do tenant chỉnh được, quyền bị thu hồi phải có hiệu lực ngay.
  async validate(payload: JwtPayload): Promise<AuthUser> {
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

    // AuthUser tách branch/warehouse vì mọi kiểm tra phạm vi dựa trên hai trường này; DB chỉ lưu một `location_id`, loại của Location cho biết thuộc bên nào.
    const { branchId, warehouseId } = columnsOfLocation(user.location);

    // Trưởng ca đang chạy có thêm quyền cố định trong suốt ca; tính lại ở mỗi request để ca vừa kết thúc không còn cấp quyền.
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
