import { Module } from '@nestjs/common';
import { StockMovementController } from './stock-movement-requests.controller';
import { StockMovementService } from './stock-movement-requests.service';
import { InventoryModule } from '../inventories/inventories.module';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  // InventoryModule for the stock primitives, NotificationModule for the fan-out to the locations involved.
  imports: [InventoryModule, NotificationModule],
  controllers: [StockMovementController],
  providers: [StockMovementService],
  exports: [StockMovementService],
})
export class StockMovementRequestModule {}
