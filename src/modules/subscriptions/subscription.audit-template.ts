import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditTemplate } from '../../common/audit/audit-descriptor';
import type {
  AuditDescribeContext,
  AuditDescribed,
  AuditDescriptor,
} from '../../common/audit/audit-descriptor';

// Mô tả audit do domain subscription sở hữu cho việc đổi gói của admin nền tảng; tách khỏi AuditInterceptor để file đó không phụ thuộc domain.
@Injectable()
@AuditTemplate()
export class SubscriptionAuditTemplate implements AuditDescriptor {
  constructor(private readonly prisma: PrismaService) {}

  matches(path: string): boolean {
    // `/subscription/upgrade/:tenantId` và `/subscription/upgrade/initiate` có chung chuỗi con, nên `.includes()` đơn thuần sẽ khớp nhầm route do tenant khởi tạo.
    return (
      path.includes('/subscription/upgrade/') && !path.endsWith('/initiate')
    );
  }

  async describe({
    request,
    path,
    action,
  }: AuditDescribeContext): Promise<AuditDescribed> {
    const rawTenantId = request.params?.tenantId ?? path.split('/').pop();
    const tenantId = Array.isArray(rawTenantId) ? rawTenantId[0] : rawTenantId;

    let resource = `Tenant ID: ${tenantId}`;
    if (tenantId) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
      });
      if (tenant) resource = `${tenant.name} - ${tenant.phoneNumber ?? 'N/A'}`;
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const details =
      action === 'CREATE'
        ? `Nâng cấp gói cước subscription trực tiếp lên gói ${(body.planCode as string) ?? 'N/A'}`
        : `Thao tác gói cước subscription (${(body.planCode as string) ?? 'N/A'})`;

    return { resource, details };
  }
}
