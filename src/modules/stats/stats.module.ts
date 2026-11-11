import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { AdminStatsController } from './admin-stats.controller';
import { StatsService } from './stats.service';
import { StatsReportsService } from './stats-reports.service';
import { AdminStatsService } from './admin-stats.service';

// Không import gì: dashboard chỉ đọc nên chỉ cần PrismaService (global).
@Module({
  controllers: [StatsController, AdminStatsController],
  providers: [StatsService, StatsReportsService, AdminStatsService],
  // Export cho công cụ báo cáo của trợ lý AI: phải trả cùng số với dashboard, không có bản tính riêng.
  exports: [StatsService],
})
export class StatsModule {}
