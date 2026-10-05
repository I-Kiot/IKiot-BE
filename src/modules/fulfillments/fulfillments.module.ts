import { Module } from '@nestjs/common';
import { FulfillmentController } from './fulfillments.controller';
import { FulfillmentService } from './fulfillments.service';
import { InventoryModule } from '../inventories/inventories.module';

@Module({
  imports: [InventoryModule],
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
