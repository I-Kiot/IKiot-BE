import { Module } from '@nestjs/common';
import { InventoryController } from './inventories.controller';
import { InventoryService } from './inventories.service';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationModule],
  controllers: [InventoryController],
  // Exported for ProductModule (opening stock) and for Order and StockMovement (adjustStock / lowStockCrossing / notifyLowStock).
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
