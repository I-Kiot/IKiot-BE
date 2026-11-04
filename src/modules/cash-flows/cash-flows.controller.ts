import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CashFlowService } from './cash-flows.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { resolveTenantScope } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Chỉ đọc có chủ đích: iKiotMS-BE chưa từng có route ghi `CashFlow`. POST/PATCH/DELETE sinh tự động đã bị xoá vì cho phép ghi nhận doanh thu chưa xảy ra; các cặp permission tương ứng để trống. */
@ApiTags('cash-flows')
@ApiBearerAuth('bearer')
@Controller('cash-flows')
export class CashFlowController {
  constructor(private readonly service: CashFlowService) {}

  @Permissions('cash_flows', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query('tenantId') tenantId?: string) {
    return this.service.findAll(resolveTenantScope(user, tenantId));
  }

  @Permissions('cash_flows', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.service.findOne(resolveTenantScope(user, tenantId), id);
  }
}
