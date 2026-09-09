import { Module } from '@nestjs/common';
import { PromotionController } from './promotions.controller';
import { PromotionService } from './promotions.service';

@Module({
  controllers: [PromotionController],
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionModule {}
