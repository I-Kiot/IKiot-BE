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
import { OrderEditService } from './order-edit.service';
import { OrderCustomizationService } from './order-customization.service';
import { OrderRemittanceService } from './order-remittance.service';
import { OrderPickupService } from './order-pickup.service';
import { CustomerModule } from '../customers/customers.module';
import { ProductionRequestModule } from '../production-requests/production-requests.module';
import { OrderShortageAlerts } from './order-shortage-alerts';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { PromotionModule } from '../promotions/promotions.module';
import { FulfillmentModule } from '../fulfillments/fulfillments.module';
import { ShipmentModule } from '../shipments/shipments.module';
import { InvoiceModule } from '../invoices/invoices.module';

@Module({
  // InventoryModule: trừ kho và quy tắc tồn thấp. PromotionModule: đơn tính KM qua cùng engine với /promotions/calculate.
  // FulfillmentModule (đóng gói C-1), ShipmentModule (giao C-2), CustomerModule (khách của đơn tay A-2).
  imports: [
    InventoryModule,
    NotificationModule,
    PromotionModule,
    FulfillmentModule,
    ShipmentModule,
    CustomerModule,
    // InvoiceService: mọi đơn đều có hóa đơn, phát hành khi đơn COMPLETED.
    InvoiceModule,
    // ProductionListService cho cảnh báo thiếu hàng khi đơn đổi nhu cầu (B-3).
    ProductionRequestModule,
  ],
  controllers: [OrderController, SepayOrderWebhookController],
  providers: [
    OrderService,
    SepayOrderService,
    OrderPricingService,
    ManualOrderService,
    OrderCancelService,
    OrderReadService,
    OrderEditService,
    OrderCustomizationService,
    OrderRemittanceService,
    OrderPickupService,
    OrderShortageAlerts,
  ],
  exports: [OrderService],
})
export class OrderModule {}
