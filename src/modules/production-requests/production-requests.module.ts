import { Module } from '@nestjs/common';
import {
  ProductionListController,
  ProductionRequestController,
} from './production-requests.controller';
import {
  ProductionDeliveryController,
  WorkshopController,
} from './production-deliveries.controller';
import { ProductionRequestService } from './production-requests.service';
import { ProductionListService } from './production-list.service';
import { ProductionDeliveryService } from './production-deliveries.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { SupplierModule } from '../suppliers/suppliers.module';
import { ProductModule } from '../products/products.module';

@Module({
  // InventoryModule cho `openLot` (nhận hàng), SupplierModule cho công nợ xưởng, NotificationModule cho thông báo thiếu / hàng về / phiếu giao.
  imports: [InventoryModule, NotificationModule, SupplierModule, ProductModule],
  controllers: [
    ProductionRequestController,
    ProductionListController,
    WorkshopController,
    ProductionDeliveryController,
  ],
  providers: [
    ProductionRequestService,
    ProductionListService,
    ProductionDeliveryService,
  ],
  // ProductionListService cho hook thiếu hàng của module đơn (B-3: `shortagesFor` / `notifyNewShortages`).
  exports: [ProductionRequestService, ProductionListService],
})
export class ProductionRequestModule {}
