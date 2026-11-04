import { Module } from '@nestjs/common';
import { InventoryController } from './inventories.controller';
import { InventoryService } from './inventories.service';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationModule],
  controllers: [InventoryController],
  // Export cho ProductModule (tồn đầu) và Order / StockMovement (lowStockCrossing / notifyLowStock).
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
