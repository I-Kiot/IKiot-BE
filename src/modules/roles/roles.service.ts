import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AUTO_GRANTED_PERMISSIONS } from '../../common/constants/system-role';
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
        // Tài khoản đã xoá mềm vẫn giữ roleId; số "đang dùng" không được tính chúng.
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
      (row) => !AUTO_GRANTED_PERMISSIONS.has(`${row.resource}:${row.action}`),
    );
  }

  private grantable(
    permissions: { resource: string; action: string }[],
  ): { resource: string; action: string }[] {
    return permissions
      .filter((p) => !AUTO_GRANTED_PERMISSIONS.has(`${p.resource}:${p.action}`))
      .map((p) => ({ resource: p.resource, action: p.action }));
  }

  /**
   * Từ chối tên vai trò đã có trong shop (ROLE_NAME_TAKEN), để client hiện được câu riêng thay vì lỗi chung.
   * So khớp chính xác như `@@unique([tenantId, name])`. Chỉ là kiểm tra sớm: hai request trùng tên cùng lúc vẫn có thể
   * cùng qua, khi đó ràng buộc DB chặn người ghi sau và `AllExceptionsFilter` trả 409 UNIQUE_VIOLATION.
   * `exceptId`: vai trò đang sửa, không tính là trùng với chính nó.
   */
  private async assertNameAvailable(
    tenantId: string,
    name: string,
    exceptId?: string,
  ) {
    const taken = await this.prisma.role.findFirst({
      where: {
        tenantId,
        name,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: ErrorCode.ROLE_NAME_TAKEN,
        message: 'A role with this name already exists',
      });
    }
  }

  async create(tenantId: string, dto: CreateRoleDto) {
    await this.assertNameAvailable(tenantId, dto.name);
    return this.prisma.role.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        permissions: { create: this.grantable(dto.permissions) },
      },
      include: { permissions: { select: { resource: true, action: true } } },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateRoleDto) {
    await this.findOne(tenantId, id);
    if (dto.name !== undefined) {
      await this.assertNameAvailable(tenantId, dto.name, id);
    }

    return this.prisma.$transaction(async (tx) => {
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
  }

  async remove(tenantId: string, id: string) {
    const role = await this.findOne(tenantId, id);
    // Chỉ tài khoản còn hoạt động mới chặn việc xoá; nhân viên đã xoá mềm vẫn giữ roleId (là FK) nên các row đó được gỡ ở dưới, không đếm.
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
}
