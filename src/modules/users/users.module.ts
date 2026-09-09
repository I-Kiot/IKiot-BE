import { Module } from '@nestjs/common';
import { UserController } from './users.controller';
import { UserService } from './users.service';
import { NotificationModule } from '../notifications/notifications.module';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // NotificationModule: activating a staff login tells the employee. SubscriptionModule: hiring consumes a seat, so `create` checks the plan's user quota. AuthModule: deactivating, deleting or resetting a password has to end that account's sessions, and `revokeAllFor` is the one seam that does it for both transports.
  imports: [NotificationModule, SubscriptionModule, AuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
