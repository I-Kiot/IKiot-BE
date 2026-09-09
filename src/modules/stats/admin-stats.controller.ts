import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminStatsService } from './admin-stats.service';
import { AdminOverviewQueryDto } from './dto/stats-query.dto';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';

/** The platform operator's dashboard. The old router's in-handler `role === 'SUPER_ADMIN'` test is `AdminOnlyGuard` here, so a second admin route cannot forget it; no `@Permissions`, since a platform admin holds no tenant role to check against. */
@ApiTags('stats')
@ApiBearerAuth('bearer')
@UseGuards(AdminOnlyGuard)
@Controller('stats/admin')
export class AdminStatsController {
  constructor(private readonly service: AdminStatsService) {}

  @Get('overview')
  overview(@Query() query: AdminOverviewQueryDto) {
    return this.service.getOverview(query);
  }
}
