import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditLogService } from './audit-logs.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { OwnerOrAdminGuard } from '../../common/guards/owner-or-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Nhật ký của tenant, chỉ owner. Nếu sau này staff cần xem, hãy thêm `audit_logs:read` và dùng @Permissions(), đừng nới lỏng guard.
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
