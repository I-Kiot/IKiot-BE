import { Module } from '@nestjs/common';
import { BrandController } from './brands.controller';
import { BrandService } from './brands.service';

@Module({
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandModule {}
