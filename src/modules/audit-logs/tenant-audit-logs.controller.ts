import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditLogService } from './audit-logs.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { OwnerOrAdminGuard } from '../../common/guards/owner-or-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// A tenant's own audit trail, owner-only; if staff ever need it, gate this with @Permissions() against a new `audit_logs:read` entry rather than loosening the guard.
@ApiTags('audit-logs')
@ApiBearerAuth('bearer')
@UseGuards(OwnerOrAdminGuard)
@Controller('audit-logs')
export class TenantAuditLogController {
  constructor(private readonly service: AuditLogService) {}

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryAuditLogDto) {
    return this.service.findForTenant(requireTenantId(user), query);
  }
}
