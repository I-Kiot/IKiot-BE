import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { QueryOrderActivityDto } from './dto/query-order-activity.dto';

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

    return {
      data: rows.map(({ order, ...row }) => ({
        ...row,
        orderId: order.id,
        orderCode: order.code,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
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

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
