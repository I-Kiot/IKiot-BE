import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
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
        _count: { select: { users: true } },
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

  permissionCatalog() {
    return this.prisma.permissionCatalog.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async create(tenantId: string, dto: CreateRoleDto) {
    try {
      return await this.prisma.role.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          permissions: {
            create: dto.permissions.map((p) => ({
              resource: p.resource,
              action: p.action,
            })),
          },
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
            data: dto.permissions.map((p) => ({
              roleId: id,
              resource: p.resource,
              action: p.action,
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
    const assignedCount = await this.prisma.user.count({
      where: { roleId: role.id },
    });
    if (assignedCount > 0) {
      throw new ConflictException({
        code: ErrorCode.ROLE_IN_USE,
        message: `Cannot delete a role assigned to ${assignedCount} user(s) - reassign them first`,
      });
    }
    await this.prisma.role.delete({ where: { id } });
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
