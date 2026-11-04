import { Module } from '@nestjs/common';
import { WarehouseController } from './warehouses.controller';
import { WarehouseService } from './warehouses.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule cung cấp cổng hạn mức gói khi tạo kho.
  imports: [SubscriptionModule],
  controllers: [WarehouseController],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
