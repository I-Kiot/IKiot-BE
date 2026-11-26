import { Module } from '@nestjs/common';
import { ProductController } from './products.controller';
import { ProductService } from './products.service';
import { ProductVariantService } from './product-variant.service';
import { ProductImportService } from './import/product-import.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // Module sản phẩm; dùng SubscriptionModule cho hạn mức.
  imports: [SubscriptionModule],
  controllers: [ProductController],
  providers: [ProductService, ProductVariantService, ProductImportService],
  exports: [ProductService, ProductVariantService],
})
export class ProductModule {}
