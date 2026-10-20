import { Module } from '@nestjs/common';
import { ProductController } from './products.controller';
import { ProductService } from './products.service';
import { ProductVariantService } from './product-variant.service';
import { SubscriptionModule } from '../subscriptions/subscriptions.module';

@Module({
  // SubscriptionModule for the product quota. No InventoryModule: creating a product writes
  // no stock rows - they appear at a location when a stock movement first puts goods there.
  imports: [SubscriptionModule],
  controllers: [ProductController],
  providers: [ProductService, ProductVariantService],
  exports: [ProductService, ProductVariantService],
})
export class ProductModule {}
