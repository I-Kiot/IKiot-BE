import { Module } from '@nestjs/common';
import { ShipmentController } from './shipments.controller';
import { ShipmentService } from './shipments.service';

@Module({
  controllers: [ShipmentController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
