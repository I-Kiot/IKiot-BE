import { Module } from '@nestjs/common';
import { AuditLogController } from './audit-logs.controller';
import { TenantAuditLogController } from './tenant-audit-logs.controller';
import { AuditLogService } from './audit-logs.service';

@Module({
  controllers: [AuditLogController, TenantAuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
