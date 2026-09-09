import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditTemplate } from '../../common/audit/audit-descriptor';
import type {
  AuditDescribeContext,
  AuditDescribed,
  AuditDescriptor,
} from '../../common/audit/audit-descriptor';

// Domain-owned audit description for the platform-admin plan change, moved out of AuditInterceptor so that file stays domain-agnostic.
@Injectable()
@AuditTemplate()
export class SubscriptionAuditTemplate implements AuditDescriptor {
  constructor(private readonly prisma: PrismaService) {}

  matches(path: string): boolean {
    // `/subscription/upgrade/:tenantId` and `/subscription/upgrade/initiate` share a substring, so a plain `.includes()` would misfire on the tenant-initiated route.
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
