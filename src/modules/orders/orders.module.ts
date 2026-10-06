import { Module } from '@nestjs/common';
import {
  OrderController,
  SepayOrderWebhookController,
} from './orders.controller';
import { OrderService } from './orders.service';
import { OrderReadService } from './order-read.service';
import { SepayOrderService } from './sepay-order.service';
import { OrderPricingService } from './order-pricing.service';
import { ManualOrderService } from './manual-order.service';
import { OrderCancelService } from './order-cancel.service';
import { CustomerModule } from '../customers/customers.module';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { PromotionModule } from '../promotions/promotions.module';
import { FulfillmentModule } from '../fulfillments/fulfillments.module';
import { ShipmentModule } from '../shipments/shipments.module';

@Module({
  // InventoryModule for the stock decrement and low-stock rule, NotificationModule for the "customer paid" push, PromotionModule so an order prices its discounts through the same engine /promotions/calculate uses, FulfillmentModule for POST /orders/:id/pack (C-1), ShipmentModule for POST /orders/:id/ship (C-2), CustomerModule for the customer a manual order types in (A-2).
  imports: [
    InventoryModule,
    NotificationModule,
    PromotionModule,
    FulfillmentModule,
    ShipmentModule,
    CustomerModule,
  ],
  controllers: [OrderController, SepayOrderWebhookController],
  providers: [
    OrderService,
    SepayOrderService,
    OrderPricingService,
    ManualOrderService,
    OrderCancelService,
    OrderReadService,
  ],
  exports: [OrderService],
})
export class OrderModule {}
