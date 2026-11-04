import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenants.dto';
import { UpdateTenantDto } from './dto/update-tenants.dto';
import {
  TENANT_SELECT,
  isSepayLinked,
  withNestedBanking,
} from './tenant-select';
import { ErrorCode } from '../../common/errors/error-codes';

/** CRUD mọi tenant cho admin nền tảng. Shop tự đọc/sửa hồ sơ của mình đi qua `TenantSelfService`, nơi lấy tenant id từ access token. */
@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  /** Trả `hasSepayKey` thay cho key; key không bao giờ rời API. */
  async findAll() {
    const rows = await this.prisma.tenant.findMany({
      select: {
        ...TENANT_SELECT,
        bankingSepayWebhookApiKey: true,
        bankingSepayLinkedAt: true,
      },
    });
    return rows.map(
      ({ bankingSepayWebhookApiKey, bankingSepayLinkedAt, ...row }) => ({
        ...withNestedBanking(row),
        hasSepayKey: isSepayLinked({
          bankingSepayWebhookApiKey,
          bankingSepayLinkedAt,
        }),
      }),
    );
  }

  // Dùng findFirst và throw tường minh thay vì findFirstOrThrow: lỗi not-found của Prisma không phải HttpException, và row của shop khác phải trông y hệt row không tồn tại.
  async findOne(id: string) {
    const found = await this.prisma.tenant.findFirst({
      where: { id },
      select: {
        ...TENANT_SELECT,
        bankingSepayWebhookApiKey: true,
        bankingSepayLinkedAt: true,
      },
    });
    if (!found)
      throw new NotFoundException({
        code: ErrorCode.TENANT_NOT_FOUND,
        message: 'Tenant not found',
      });
    const { bankingSepayWebhookApiKey, bankingSepayLinkedAt, ...row } = found;
    return {
      ...withNestedBanking(row),
      hasSepayKey: isSepayLinked({
        bankingSepayWebhookApiKey,
        bankingSepayLinkedAt,
      }),
    };
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
