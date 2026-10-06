import { Module } from '@nestjs/common';
import { ShipmentController } from './shipments.controller';
import { ShipmentService } from './shipments.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  // InventoryModule cho shipLockedStock (trừ hàng đã khoá lúc ship), NotificationModule để báo shipper được gán. OrderModule import module này cho POST /orders/:id/ship.
  imports: [InventoryModule, NotificationModule],
  controllers: [ShipmentController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
