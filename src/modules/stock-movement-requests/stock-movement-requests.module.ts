import { Module } from '@nestjs/common';
import { StockMovementController } from './stock-movement-requests.controller';
import { StockMovementService } from './stock-movement-requests.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';
import { SupplierModule } from '../suppliers/suppliers.module';

@Module({
  // InventoryModule for the stock primitives, NotificationModule for the fan-out to the locations involved, SupplierModule for the payables rules a receipt applies.
  imports: [InventoryModule, NotificationModule, SupplierModule],
  controllers: [StockMovementController],
  providers: [StockMovementService],
  exports: [StockMovementService],
})
export class StockMovementRequestModule {}
