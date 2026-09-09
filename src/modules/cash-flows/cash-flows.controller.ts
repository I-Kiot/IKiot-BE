import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CashFlowService } from './cash-flows.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { resolveTenantScope } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Read-only by design: iKiotMS-BE never exposed a route that wrote a `CashFlow` row - the ledger is written by the events that moved money. The generated `POST`/`PATCH`/`DELETE` were a way to book revenue that never happened, so they are removed and the matching catalog pairs stay unused. */
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
