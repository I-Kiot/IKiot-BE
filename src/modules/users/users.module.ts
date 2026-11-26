import { Module } from '@nestjs/common';
import { UserController } from './users.controller';
import { UserService } from './users.service';
import { NotificationModule } from '../notifications/notifications.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // Phụ thuộc: thông báo, gói dịch vụ, auth.
  imports: [NotificationModule, SubscriptionModule, AuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
