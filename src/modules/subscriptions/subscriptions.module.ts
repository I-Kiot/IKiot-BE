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
  // Only SubscriptionService is exported - other modules gate features on the subscription, and nobody outside raises an invoice. SubscriptionAuditTemplate needs no export either; AuditInterceptor discovers it by decorator.
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
