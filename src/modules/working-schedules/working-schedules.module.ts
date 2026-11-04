import { Module } from '@nestjs/common';
import { WorkingScheduleController } from './working-schedules.controller';
import { WorkingScheduleService } from './working-schedules.service';
import { ShiftSupervisorService } from './shift-supervisor.service';
import { ShiftTemplateModule } from '../shift-templates/shift-templates.module';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  imports: [ShiftTemplateModule, NotificationModule],
  controllers: [WorkingScheduleController],
  providers: [WorkingScheduleService, ShiftSupervisorService],
  exports: [WorkingScheduleService, ShiftSupervisorService],
})
export class WorkingScheduleModule {}
