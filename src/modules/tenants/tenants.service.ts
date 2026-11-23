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
import { withNestedProfile } from '../../common/utils/user-profile';
import type { Prisma } from '../../../generated/prisma/client';

const OWNER_SELECT = {
  id: true,
  email: true,
  phoneNumber: true,
  status: true,
  createdAt: true,
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
} as const satisfies Prisma.UserSelect;

const PLAN_BRIEF_SELECT = {
  id: true,
  planName: true,
  planCode: true,
  billingCycle: true,
} as const satisfies Prisma.PlanSelect;

/** CRUD mọi tenant cho admin nền tảng. Shop tự đọc/sửa hồ sơ của mình đi qua `TenantSelfService`, nơi lấy tenant id từ access token. */
@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Trả `hasSepayKey` thay cho key; key không bao giờ rời API.
   * Kèm chủ shop (`tenantOwner`), gói hiện tại (`subscription`, mỗi shop một bản ghi) và hoá đơn gói cho trang admin "Người dùng".
   * Trước đây chỉ có `tenantOwnerId` dạng chuỗi nên màn đó luôn hiện "Dùng thử" và không có tên chủ.
   */
  async findAll() {
    const rows = await this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        ...TENANT_SELECT,
        bankingSepayWebhookApiKey: true,
        bankingSepayLinkedAt: true,
        tenantOwner: { select: OWNER_SELECT },
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            trialEndDate: true,
            plan: { select: PLAN_BRIEF_SELECT },
          },
        },
        subscriptionInvoices: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            billingPeriodStart: true,
            billingPeriodEnd: true,
            paidAt: true,
            paymentReference: true,
            paymentMethod: true,
            createdAt: true,
            plan: { select: PLAN_BRIEF_SELECT },
          },
        },
      },
    });
    return rows.map(
      ({
        bankingSepayWebhookApiKey,
        bankingSepayLinkedAt,
        tenantOwner,
        subscriptions,
        subscriptionInvoices,
        ...row
      }) => ({
        ...withNestedBanking(row),
        hasSepayKey: isSepayLinked({
          bankingSepayWebhookApiKey,
          bankingSepayLinkedAt,
        }),
        tenantOwner: tenantOwner ? withNestedProfile(tenantOwner) : null,
        subscription: subscriptions?.[0] ?? null,
        // Decimal lên JSON thành chuỗi: ép số để FE cộng tổng được.
        invoices: (subscriptionInvoices ?? []).map((invoice) => ({
          ...invoice,
          amount: Number(invoice.amount),
        })),
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
