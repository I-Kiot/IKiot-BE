import { Module } from '@nestjs/common';
import { HolidayController } from './holidays.controller';
import { HolidayService } from './holidays.service';
import { HolidaySyncService } from './holiday-sync.service';
import { HolidayCronService } from './holiday-cron.service';

@Module({
  controllers: [HolidayController],
  providers: [HolidayService, HolidaySyncService, HolidayCronService],
  exports: [HolidayService, HolidaySyncService],
})
export class HolidayModule {}
