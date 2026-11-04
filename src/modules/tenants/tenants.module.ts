import { Module } from '@nestjs/common';
import { TenantController } from './tenants.controller';
import { TenantService } from './tenants.service';
import { TenantSelfController } from './tenant-self.controller';
import { TenantSelfService } from './tenant-self.service';
import { SepayAccountSyncService } from './sepay-account-sync.service';
import { NotificationModule } from '../notifications/notifications.module';

// Hai controller có chủ đích: `/tenants` là CRUD admin trên mọi shop, `/tenant` là cài đặt của một shop.
@Module({
  imports: [NotificationModule],
  controllers: [TenantController, TenantSelfController],
  providers: [TenantService, TenantSelfService, SepayAccountSyncService],
  exports: [TenantService],
})
export class TenantModule {}
