import { Module } from '@nestjs/common';
import {
  OrderController,
  SepayOrderWebhookController,
} from './orders.controller';
import { OrderService } from './orders.service';
import { SepayOrderService } from './sepay-order.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { PromotionModule } from '../promotions/promotions.module';

@Module({
  // InventoryModule for the stock decrement and low-stock rule, NotificationModule for the "customer paid" push, PromotionModule so an order prices its discounts through the same engine /promotions/calculate uses.
  imports: [InventoryModule, NotificationModule, PromotionModule],
  controllers: [OrderController, SepayOrderWebhookController],
  providers: [OrderService, SepayOrderService],
  exports: [OrderService],
})
export class OrderModule {}
