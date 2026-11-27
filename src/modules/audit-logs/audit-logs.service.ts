import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { QueryOrderActivityDto } from './dto/query-order-activity.dto';

export interface AuditActor {
  id: string;
  /** Họ tên theo hồ sơ hiện tại; null khi hồ sơ chưa có tên. */
  name: string | null;
  phone: string;
  avatarUrl: string | null;
  systemRole: string;
  /** Chức danh hiển thị: tên Role của nhân viên, hoặc nhãn của chủ shop / quản trị. */
  roleLabel: string;
}

const SYSTEM_ROLE_LABELS: Record<string, string> = {
  TENANT_OWNER: 'Chủ cửa hàng',
  ADMIN: 'Quản trị viên',
};

// Nhật ký chỉ đọc, chỉ AuditInterceptor ghi.
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Toàn nền tảng, không lọc theo tenant - GET /admin/audit-logs (AdminOnlyGuard). */
  findAllAdmin(query: QueryAuditLogDto) {
    return this.query(this.buildWhere(query), query);
  }

  /** Nhật ký của riêng một tenant - GET /audit-logs (OwnerOrAdminGuard). */
  findForTenant(tenantId: string, query: QueryAuditLogDto) {
    return this.query({ ...this.buildWhere(query), tenantId }, query);
  }

  /** Thao tác trên đơn hàng của cả cửa hàng (người thao tác, thay đổi, trạng thái), mới nhất trước - GET /audit-logs/order-events. */
  async findOrderActivityForTenant(
    tenantId: string,
    query: QueryOrderActivityDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.OrderEventWhereInput = { tenantId };
    if (query.actor) {
      where.actorName = { contains: query.actor, mode: 'insensitive' };
    }
    if (query.type) where.type = query.type;
    if (query.orderCode) {
      where.order = {
        code: { contains: query.orderCode, mode: 'insensitive' },
      };
    }
    if (query.startDate || query.endDate) {
      where.occurredAt = {};
      if (query.startDate) where.occurredAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        where.occurredAt.lte = end;
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.orderEvent.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          fromStatus: true,
          toStatus: true,
          source: true,
          actorId: true,
          actorName: true,
          actorRole: true,
          changes: true,
          metadata: true,
          occurredAt: true,
          order: { select: { id: true, code: true } },
        },
      }),
      this.prisma.orderEvent.count({ where }),
    ]);

    const actors = await this.loadActors(rows.map((r) => r.actorId));
    return {
      data: rows.map(({ order, ...row }) => ({
        ...row,
        orderId: order.id,
        orderCode: order.code,
        actor: (row.actorId && actors.get(row.actorId)) || null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Hồ sơ hiện tại của người thao tác, tra theo id; người đã xóa thì không có trong kết quả. */
  private async loadActors(
    ids: (string | null | undefined)[],
  ): Promise<Map<string, AuditActor>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        phoneNumber: true,
        systemRole: true,
        profileFirstName: true,
        profileLastName: true,
        profileAvatarUrl: true,
        role: { select: { name: true } },
      },
    });
    return new Map(
      users.map((u) => {
        const name =
          [u.profileLastName, u.profileFirstName]
            .filter(Boolean)
            .join(' ')
            .trim() || null;
        return [
          u.id,
          {
            id: u.id,
            name,
            phone: u.phoneNumber,
            avatarUrl: u.profileAvatarUrl,
            systemRole: u.systemRole,
            roleLabel:
              SYSTEM_ROLE_LABELS[u.systemRole] ?? u.role?.name ?? 'Nhân viên',
          },
        ] as const;
      }),
    );
  }

  private buildWhere(query: QueryAuditLogDto): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.user) {
      where.OR = [
        { userName: { contains: query.user, mode: 'insensitive' } },
        { userEmail: { contains: query.user, mode: 'insensitive' } },
      ];
    }
    if (query.action && query.action.toLowerCase() !== 'all') {
      where.action = query.action.toUpperCase();
    }
    if (query.resource && query.resource.toLowerCase() !== 'all') {
      where.resource = { contains: query.resource, mode: 'insensitive' };
    }
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    return where;
  }

  private async query(
    where: Prisma.AuditLogWhereInput,
    query: QueryAuditLogDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const actors = await this.loadActors(data.map((r) => r.userId));
    return {
      data: data.map((row) => ({
        ...row,
        actor: (row.userId && actors.get(row.userId)) || null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
