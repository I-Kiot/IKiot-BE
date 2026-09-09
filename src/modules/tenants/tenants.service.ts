import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenants.dto';
import { UpdateTenantDto } from './dto/update-tenants.dto';
import { TENANT_SELECT, withNestedBanking } from './tenant-select';
import { ErrorCode } from '../../common/errors/error-codes';

/** Platform-admin CRUD over every tenant. A shop reading or editing its own record goes through `TenantSelfService`, which takes the tenant id off the access token. */
@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    const rows = await this.prisma.tenant.findMany({ select: TENANT_SELECT });
    return rows.map((row) => withNestedBanking(row));
  }

  // findFirst + explicit throw rather than findFirstOrThrow: Prisma's not-found error isn't an HttpException, and a row in another tenant must be indistinguishable from one that doesn't exist.
  async findOne(id: string) {
    const found = await this.prisma.tenant.findFirst({
      where: { id },
      select: TENANT_SELECT,
    });
    if (!found)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Tenant not found',
      });
    return withNestedBanking(found);
  }

  async create(data: CreateTenantDto) {
    const created = await this.prisma.tenant.create({
      data: { ...data },
      select: TENANT_SELECT,
    });
    return withNestedBanking(created);
  }

  async update(id: string, data: UpdateTenantDto) {
    await this.findOne(id);
    const updated = await this.prisma.tenant.update({
      where: { id },
      data,
      select: TENANT_SELECT,
    });
    return withNestedBanking(updated);
  }

  async remove(id: string) {
    await this.findOne(id);
    const removed = await this.prisma.tenant.delete({
      where: { id },
      select: TENANT_SELECT,
    });
    return withNestedBanking(removed);
  }
}
