import { Module } from '@nestjs/common';
import { UserController } from './users.controller';
import { UserService } from './users.service';
import { NotificationModule } from '../notifications/notifications.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // NotificationModule: bật login nhân viên sẽ báo cho họ. SubscriptionModule: tuyển người tốn một seat nên `create` kiểm tra hạn mức user của gói. AuthModule: khoá, xoá hoặc đặt lại mật khẩu phải kết thúc phiên của tài khoản đó; `revokeAllFor` là điểm duy nhất làm việc này cho cả hai kênh.
  imports: [NotificationModule, SubscriptionModule, AuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
