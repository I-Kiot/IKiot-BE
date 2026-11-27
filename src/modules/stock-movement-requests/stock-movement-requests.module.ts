import { Module } from '@nestjs/common';
import { StockMovementController } from './stock-movement-requests.controller';
import { StockMovementService } from './stock-movement-requests.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { SupplierModule } from '../suppliers/suppliers.module';

@Module({
  // Phụ thuộc: kho, thông báo, nhà cung cấp.
  imports: [InventoryModule, NotificationModule, SupplierModule],
  controllers: [StockMovementController],
  providers: [StockMovementService],
  exports: [StockMovementService],
})
export class StockMovementRequestModule {}
