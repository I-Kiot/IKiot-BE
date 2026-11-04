import { Module } from '@nestjs/common';
import { TenantController } from './tenants.controller';
import { TenantService } from './tenants.service';
import { TenantSelfController } from './tenant-self.controller';
import { TenantSelfService } from './tenant-self.service';
import { SepayAccountSyncService } from './sepay-account-sync.service';
import { NotificationModule } from '../notifications/notifications.module';

// Two controllers on purpose: `/tenants` is admin CRUD over every shop, `/tenant` is one shop's own settings.
@Module({
  imports: [NotificationModule],
  controllers: [TenantController, TenantSelfController],
  providers: [TenantService, TenantSelfService, SepayAccountSyncService],
  exports: [TenantService],
})
export class TenantModule {}
