import { Module } from '@nestjs/common';
import { WarehouseController } from './warehouses.controller';
import { WarehouseService } from './warehouses.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule provides the plan quota gate applied when creating a warehouse.
  imports: [SubscriptionModule],
  controllers: [WarehouseController],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
