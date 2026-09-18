import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { STAFF_BASE_PERMISSIONS } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ErrorCode } from '../../common/errors/error-codes';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(tenantId: string) {
    return this.prisma.role.findMany({
      where: { tenantId },
      include: {
        permissions: { select: { resource: true, action: true } },
        // Soft-deleted accounts keep their roleId; the "in use" figure must not count them.
        _count: {
          select: { users: { where: { status: { not: UserStatus.DELETED } } } },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, tenantId },
      include: { permissions: { select: { resource: true, action: true } } },
    });
    if (!role)
      throw new NotFoundException({
        code: ErrorCode.ROLE_NOT_FOUND,
        message: 'Role not found',
      });
    return role;
  }

  async permissionCatalog() {
    const rows = await this.prisma.permissionCatalog.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
    return rows.filter(
      (row) => !STAFF_BASE_PERMISSIONS.has(`${row.resource}:${row.action}`),
    );
  }

  private grantable(
    permissions: { resource: string; action: string }[],
  ): { resource: string; action: string }[] {
    return permissions
      .filter((p) => !STAFF_BASE_PERMISSIONS.has(`${p.resource}:${p.action}`))
      .map((p) => ({ resource: p.resource, action: p.action }));
  }

  async create(tenantId: string, dto: CreateRoleDto) {
    try {
      return await this.prisma.role.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          permissions: { create: this.grantable(dto.permissions) },
        },
        include: { permissions: { select: { resource: true, action: true } } },
      });
    } catch (error) {
      throw this.translatePrismaError(error);
    }
  }

  async update(tenantId: string, id: string, dto: UpdateRoleDto) {
    await this.findOne(tenantId, id); // 404s if missing or belongs to another tenant

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (dto.permissions) {
          await tx.rolePermission.deleteMany({ where: { roleId: id } });
          await tx.rolePermission.createMany({
            data: this.grantable(dto.permissions).map((p) => ({
              roleId: id,
              ...p,
            })),
          });
        }
        return tx.role.update({
          where: { id },
          data: { name: dto.name, description: dto.description },
          include: {
            permissions: { select: { resource: true, action: true } },
          },
        });
      });
    } catch (error) {
      throw this.translatePrismaError(error);
    }
  }

  async remove(tenantId: string, id: string) {
    const role = await this.findOne(tenantId, id);
    // Only living accounts block the delete; a soft-deleted employee still carries the roleId (it's an FK), so those rows are detached below rather than counted.
    const assignedCount = await this.prisma.user.count({
      where: { roleId: role.id, status: { not: UserStatus.DELETED } },
    });
    if (assignedCount > 0) {
      throw new ConflictException({
        code: ErrorCode.ROLE_IN_USE,
        message: `Cannot delete a role assigned to ${assignedCount} user(s) - reassign them first`,
      });
    }
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { roleId: role.id, status: UserStatus.DELETED },
        data: { roleId: null },
      }),
      this.prisma.role.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  private translatePrismaError(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2003')
        return new BadRequestException(
          'One of the given (resource, action) pairs is not a recognized permission',
        );
      if (error.code === 'P2002')
        return new ConflictException('A role with this name already exists');
    }
    return error;
  }
}
