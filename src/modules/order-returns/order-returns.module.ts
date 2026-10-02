import { Module } from '@nestjs/common';
import { OrderReturnController } from './order-returns.controller';
import { OrderReturnService } from './order-returns.service';

@Module({
  controllers: [OrderReturnController],
  providers: [OrderReturnService],
  exports: [OrderReturnService],
})
export class OrderReturnModule {}
