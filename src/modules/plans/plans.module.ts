import { Module } from '@nestjs/common';
import { PlanController } from './plans.controller';
import { AdminPlanController } from './admin-plans.controller';
import { PlanService } from './plans.service';

@Module({
  controllers: [PlanController, AdminPlanController],
  providers: [PlanService],
  exports: [PlanService],
})
export class PlanModule {}
