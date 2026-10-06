import { Module } from '@nestjs/common';
import { OrderReturnController } from './order-returns.controller';
import { OrderReturnService } from './order-returns.service';
import { InventoryModule } from '../inventories/inventories.module';
import { OrderModule } from '../orders/orders.module';

@Module({
  // InventoryModule for `returnDrawn`, OrderModule for the branch scope every order-side read shares.
  imports: [InventoryModule, OrderModule],
  controllers: [OrderReturnController],
  providers: [OrderReturnService],
  exports: [OrderReturnService],
})
export class OrderReturnModule {}
