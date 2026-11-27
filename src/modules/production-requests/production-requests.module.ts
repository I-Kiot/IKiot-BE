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
  // Phụ thuộc: kho, nhà cung cấp, thông báo.
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
  // Xuất ProductionListService cho module đơn.
  exports: [ProductionRequestService, ProductionListService],
})
export class ProductionRequestModule {}
