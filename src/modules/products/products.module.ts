import { Module } from '@nestjs/common';
import { ProductController } from './products.controller';
import { ProductService } from './products.service';
import { ProductVariantService } from './product-variant.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule cho hạn mức sản phẩm. Không import InventoryModule: tạo sản phẩm không ghi dòng tồn kho.
  imports: [SubscriptionModule],
  controllers: [ProductController],
  providers: [ProductService, ProductVariantService],
  exports: [ProductService, ProductVariantService],
})
export class ProductModule {}
