import { Module } from '@nestjs/common';
import { ShipmentController } from './shipments.controller';
import { ShipmentService } from './shipments.service';
import { ShipmentDeliveryService } from './shipment-delivery.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  // InventoryModule cho shipLockedStock (trừ hàng đã khoá lúc ship), NotificationModule để báo shipper được gán / tiền chờ nộp. OrderModule import module này cho POST /orders/:id/ship và cho webhook SePay (khoản thu QR lúc giao).
  imports: [InventoryModule, NotificationModule],
  controllers: [ShipmentController],
  providers: [ShipmentService, ShipmentDeliveryService],
  exports: [ShipmentService, ShipmentDeliveryService],
})
export class ShipmentModule {}
