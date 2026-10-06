import { Module } from '@nestjs/common';
import {
  ProductionListController,
  ProductionRequestController,
} from './production-requests.controller';
import { ProductionRequestService } from './production-requests.service';
import { ProductionListService } from './production-list.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { SupplierModule } from '../suppliers/suppliers.module';

@Module({
  // InventoryModule for `openLot` (receiving), SupplierModule for the workshop's payables, NotificationModule for the shortage / goods-arrived messages.
  imports: [InventoryModule, NotificationModule, SupplierModule],
  controllers: [ProductionRequestController, ProductionListController],
  providers: [ProductionRequestService, ProductionListService],
  // ProductionListService for the order module's shortage hook (B-3: `shortagesFor` / `notifyNewShortages`).
  exports: [ProductionRequestService, ProductionListService],
})
export class ProductionRequestModule {}
