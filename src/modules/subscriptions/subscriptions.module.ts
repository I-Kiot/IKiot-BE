import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscriptions.controller';
import { SubscriptionService } from './subscriptions.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { SepaySubscriptionService } from './sepay-subscription.service';
import { SubscriptionCronService } from './subscription-cron.service';
import { SubscriptionAuditTemplate } from './subscription.audit-template';
import { NotificationModule } from '../notifications/notifications.module';
import { EmailModule } from '../../common/email/email.module';

@Module({
  imports: [NotificationModule, EmailModule],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionService,
    SubscriptionBillingService,
    SepaySubscriptionService,
    SubscriptionCronService,
    SubscriptionAuditTemplate,
  ],
  // Chỉ xuất SubscriptionService.
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
