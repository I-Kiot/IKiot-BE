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

@Module({
  // InventoryModule for `openLot` (receiving), SupplierModule for the workshop's payables, NotificationModule for the shortage / goods-arrived / delivery messages.
  imports: [InventoryModule, NotificationModule, SupplierModule],
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
  // ProductionListService for the order module's shortage hook (B-3: `shortagesFor` / `notifyNewShortages`).
  exports: [ProductionRequestService, ProductionListService],
})
export class ProductionRequestModule {}
