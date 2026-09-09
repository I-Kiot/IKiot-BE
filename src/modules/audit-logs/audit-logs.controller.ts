import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditLogService } from './audit-logs.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';

@ApiTags('audit-logs')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller('admin/audit-logs')
export class AuditLogController {
  constructor(private readonly service: AuditLogService) {}

  @Get()
  findAll(@Query() query: QueryAuditLogDto) {
    return this.service.findAllAdmin(query);
  }
}
