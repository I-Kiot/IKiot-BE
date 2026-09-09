import { Module } from '@nestjs/common';
import { NotificationController } from './notifications.controller';
import { AdminNotificationController } from './admin-notifications.controller';
import { NotificationService } from './notifications.service';
import { AdminNotificationService } from './admin-notifications.service';
import { EmailModule } from '../../common/email/email.module';
import { PushModule } from '../../common/push/push.module';

// EmailModule for announcements, PushModule for the FCM leg of notify(). NotificationService is exported; the admin half is not, because nothing else should read the operators' feed.
@Module({
  imports: [EmailModule, PushModule],
  controllers: [NotificationController, AdminNotificationController],
  providers: [NotificationService, AdminNotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
