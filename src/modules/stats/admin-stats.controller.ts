import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminStatsService } from './admin-stats.service';
import { AdminOverviewQueryDto } from './dto/stats-query.dto';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';

/** Dashboard của operator nền tảng. `AdminOnlyGuard` ở đây thay cho check `role === 'SUPER_ADMIN'` trong handler của router cũ, nên route admin mới không thể quên nó. Không có `@Permissions` vì admin nền tảng không có role tenant. */
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
