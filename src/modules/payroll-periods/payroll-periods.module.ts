import { Module } from '@nestjs/common';
import { PayrollPeriodController } from './payroll-periods.controller';
import { PayrollPeriodService } from './payroll-periods.service';
import { PayslipBuilderService } from './payslip-builder.service';
import { PayrollSettingModule } from '../payroll-settings/payroll-settings.module';
import { NotificationModule } from '../notifications/notifications.module';

// PayrollSettingModule for the divisors every calculation uses; NotificationModule for the three transitions that tell an employee their payslip moved.
@Module({
  imports: [PayrollSettingModule, NotificationModule],
  controllers: [PayrollPeriodController],
  providers: [PayrollPeriodService, PayslipBuilderService],
  exports: [PayrollPeriodService],
})
export class PayrollPeriodModule {}
