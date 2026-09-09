import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TenantSelfService } from './tenant-self.service';
import {
  BankingDto,
  SetSepayKeyDto,
  UpdateMyTenantDto,
} from './dto/tenant-self.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** A shop's own settings, at the singular `/tenant/*` paths the old API used. The tenant id always comes from `requireTenantId(user)`, so no route here can be pointed at another shop; `/tenants` is the separate admin-only CRUD. */
@ApiTags('tenants')
@ApiBearerAuth('bearer')
@Controller('tenant')
export class TenantSelfController {
  constructor(private readonly service: TenantSelfService) {}

  /** Reading your own shop needs no permission beyond being in it - as in the old API. */
  @Get('me')
  findMine(@CurrentUser() user: AuthUser) {
    return this.service.findMine(requireTenantId(user));
  }

  @Permissions('tenants', 'update')
  @Put('me')
  updateMine(@CurrentUser() user: AuthUser, @Body() dto: UpdateMyTenantDto) {
    return this.service.updateMine(requireTenantId(user), dto);
  }

  /** The bank account SePay pays into. Without it `POST /orders` refuses a SEPAY sale. */
  @Permissions('tenants', 'update')
  @Put('banking')
  updateBanking(@CurrentUser() user: AuthUser, @Body() dto: BankingDto) {
    return this.service.updateBanking(requireTenantId(user), dto);
  }

  /** Platform-admin only - see `TenantSelfService.setSepayKey` for why this guard is a fix rather than a port. The tenant id is a path param because an operator is acting on somebody else's shop. */
  @UseGuards(AdminOnlyGuard)
  @Put(':tenantId/sepay-key')
  setSepayKey(
    @Param('tenantId') tenantId: string,
    @Body() dto: SetSepayKeyDto,
  ) {
    return this.service.setSepayKey(tenantId, dto.sepayWebhookApiKey);
  }
}
