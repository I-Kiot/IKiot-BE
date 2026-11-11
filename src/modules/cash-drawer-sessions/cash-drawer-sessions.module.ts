import { Module } from '@nestjs/common';
import { CashDrawerSessionController } from './cash-drawer-sessions.controller';
import { CashDrawerSessionService } from './cash-drawer-sessions.service';
import { CashDrawerCronService } from './cash-drawer-cron.service';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  // NotificationModule cho cron nhắc két quá hạn.
  imports: [NotificationModule],
  controllers: [CashDrawerSessionController],
  providers: [CashDrawerSessionService, CashDrawerCronService],
  exports: [CashDrawerSessionService],
})
export class CashDrawerSessionModule {}
