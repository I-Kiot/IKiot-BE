import { Module } from '@nestjs/common';
import { ProductionRequestController } from './production-requests.controller';
import { ProductionRequestService } from './production-requests.service';

@Module({
  controllers: [ProductionRequestController],
  providers: [ProductionRequestService],
  exports: [ProductionRequestService],
})
export class ProductionRequestModule {}
