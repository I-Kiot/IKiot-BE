import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InvoiceReadService } from './invoices-read.service';
import { QueryInvoiceDto } from './dto/query-invoice.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Controller hoá đơn, chỉ đọc, quyền `orders:read`. */
@ApiTags('invoices')
@ApiBearerAuth('bearer')
@Controller('invoices')
export class InvoiceController {
  constructor(private readonly reads: InvoiceReadService) {}

  @Permissions('orders', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryInvoiceDto) {
    return this.reads.findAll(user, requireTenantId(user), query);
  }

  @Permissions('orders', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reads.findOne(user, requireTenantId(user), id);
  }
}
