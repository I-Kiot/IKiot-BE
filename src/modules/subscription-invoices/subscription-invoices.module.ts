import { Module } from '@nestjs/common';
import { SubscriptionInvoiceController } from './subscription-invoices.controller';
import { SubscriptionInvoiceService } from './subscription-invoices.service';

@Module({
  controllers: [SubscriptionInvoiceController],
  providers: [SubscriptionInvoiceService],
  exports: [SubscriptionInvoiceService],
})
export class SubscriptionInvoiceModule {}
