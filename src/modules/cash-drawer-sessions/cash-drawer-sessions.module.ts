import { Module } from '@nestjs/common';
import { CashDrawerSessionController } from './cash-drawer-sessions.controller';
import { CashDrawerSessionService } from './cash-drawer-sessions.service';

@Module({
  controllers: [CashDrawerSessionController],
  providers: [CashDrawerSessionService],
  exports: [CashDrawerSessionService],
})
export class CashDrawerSessionModule {}
