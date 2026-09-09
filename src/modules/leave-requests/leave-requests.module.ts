import { Module } from '@nestjs/common';
import { LeaveRequestController } from './leave-requests.controller';
import { LeaveRequestService } from './leave-requests.service';
import { LeaveRequestCronService } from './leave-request-cron.service';
import { NotificationModule } from '../notifications/notifications.module';

// NotificationModule for the five events leave generates - filed, approved, rejected, cancelled, expired - plus approversOf/displayName.
@Module({
  imports: [NotificationModule],
  controllers: [LeaveRequestController],
  providers: [LeaveRequestService, LeaveRequestCronService],
  exports: [LeaveRequestService],
})
export class LeaveRequestModule {}
