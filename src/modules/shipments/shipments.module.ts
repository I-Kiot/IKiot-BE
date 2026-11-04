import { Module } from '@nestjs/common';
import { ShipmentController } from './shipments.controller';
import { ShipmentService } from './shipments.service';
import { ShipmentDeliveryService } from './shipment-delivery.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { InvoiceModule } from '../invoices/invoices.module';

@Module({
  // InventoryModule cho shipLockedStock (trừ hàng đã khoá), NotificationModule báo shipper / tiền chờ nộp. OrderModule import module này cho POST /orders/:id/ship và webhook SePay.
  imports: [InventoryModule, NotificationModule, InvoiceModule],
  controllers: [ShipmentController],
  providers: [ShipmentService, ShipmentDeliveryService],
  exports: [ShipmentService, ShipmentDeliveryService],
})
export class ShipmentModule {}
