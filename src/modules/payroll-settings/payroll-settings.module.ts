import { Module } from '@nestjs/common';
import { PayrollSettingController } from './payroll-settings.controller';
import { PayrollSettingService } from './payroll-settings.service';

@Module({
  controllers: [PayrollSettingController],
  providers: [PayrollSettingService],
  exports: [PayrollSettingService],
})
export class PayrollSettingModule {}
