import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

// AuditLog rows are written only by AuditInterceptor, so there is deliberately no create/update/delete here - same as iKiotMS-BE's read-only audit module.
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform-wide, unscoped - GET /admin/audit-logs (AdminOnlyGuard). */
  findAllAdmin(query: QueryAuditLogDto) {
    return this.query(this.buildWhere(query), query);
  }

  /** One tenant's own trail - GET /audit-logs (OwnerOrAdminGuard). */
  findForTenant(tenantId: string, query: QueryAuditLogDto) {
    return this.query({ ...this.buildWhere(query), tenantId }, query);
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
