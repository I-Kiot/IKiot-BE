import { Module } from '@nestjs/common';
import { AttendanceController } from './attendances.controller';
import { AttendanceService } from './attendances.service';

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
