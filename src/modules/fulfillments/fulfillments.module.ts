import { Module } from '@nestjs/common';
import { FulfillmentController } from './fulfillments.controller';
import { FulfillmentService } from './fulfillments.service';

@Module({
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
