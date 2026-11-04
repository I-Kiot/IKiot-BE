import { Module } from '@nestjs/common';
import { NotificationController } from './notifications.controller';
import { AdminNotificationController } from './admin-notifications.controller';
import { NotificationService } from './notifications.service';
import { AdminNotificationService } from './admin-notifications.service';
import { EmailModule } from '../../common/email/email.module';
import { PushModule } from '../../common/push/push.module';

// EmailModule cho announcement, PushModule cho nhánh FCM của notify(). Chỉ export NotificationService; AdminNotificationService không export để module khác không đọc được feed của operator.
@Module({
  imports: [EmailModule, PushModule],
  controllers: [NotificationController, AdminNotificationController],
  providers: [NotificationService, AdminNotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
