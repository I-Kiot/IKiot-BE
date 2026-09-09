import { Module } from '@nestjs/common';
import { PayslipController } from './payslips.controller';
import { PayslipService } from './payslips.service';

@Module({
  controllers: [PayslipController],
  providers: [PayslipService],
  exports: [PayslipService],
})
export class PayslipModule {}
