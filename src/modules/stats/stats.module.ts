import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { AdminStatsController } from './admin-stats.controller';
import { StatsService } from './stats.service';
import { AdminStatsService } from './admin-stats.service';

// No imports: the dashboard only reads, so it needs PrismaService (global) and nothing else.
@Module({
  controllers: [StatsController, AdminStatsController],
  providers: [StatsService, AdminStatsService],
  // Exported for the AI assistant's reporting tools - they must answer with the same numbers the dashboard does, not a second implementation.
  exports: [StatsService],
})
export class StatsModule {}
