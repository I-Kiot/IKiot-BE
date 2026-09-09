import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SubscriptionInvoiceService } from './subscription-invoices.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { AdminOnlyGuard } from '../../common/guards/admin-only.guard';
import type { AuthUser } from '../../common/types/auth-user.type';

@ApiTags('subscription-invoices')
@ApiBearerAuth('bearer')
@Controller('subscription')
export class SubscriptionInvoiceController {
  constructor(private readonly service: SubscriptionInvoiceService) {}

  @Get('invoices')
  listOwn(@CurrentUser() user: AuthUser) {
    return this.service.listForTenant(requireTenantId(user));
  }

  @Get('invoice/:invoiceId/status')
  getStatus(
    @CurrentUser() user: AuthUser,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.service.getStatus(requireTenantId(user), invoiceId);
  }

  @UseGuards(AdminOnlyGuard)
  @Get('admin/invoices')
  listAll() {
    return this.service.listAll();
  }
}
