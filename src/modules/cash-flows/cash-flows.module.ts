import { Module } from '@nestjs/common';
import { CashFlowController } from './cash-flows.controller';
import { CashFlowService } from './cash-flows.service';

@Module({
  controllers: [CashFlowController],
  providers: [CashFlowService],
  exports: [CashFlowService],
})
export class CashFlowModule {}
