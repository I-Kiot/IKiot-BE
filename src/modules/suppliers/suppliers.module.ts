import { Module } from '@nestjs/common';
import { SupplierController } from './suppliers.controller';
import { SupplierService } from './suppliers.service';
import { NotificationModule } from '../notifications/notifications.module';

@Module({
  // NotificationModule: trả nợ NCC thì báo chủ shop.
  imports: [NotificationModule],
  controllers: [SupplierController],
  providers: [SupplierService],
  exports: [SupplierService],
})
export class SupplierModule {}
