import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SepayTransactionService } from './sepay-transactions.service';
import { QuerySepayTransactionDto } from './dto/query-sepay-transaction.dto';
import { ResolveSepayTransactionDto } from './dto/resolve-sepay-transaction.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Sổ giao dịch SePay của shop: xem tiền về chưa chốt được và đánh dấu đã xử lý. Chỉ đọc + một thao tác "đã xử lý"; sổ không có route sửa hay xoá. */
@ApiTags('sepay-transactions')
@ApiBearerAuth('bearer')
@Controller('sepay-transactions')
export class SepayTransactionController {
  constructor(private readonly service: SepayTransactionService) {}

  @Permissions('cash_flows', 'read')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QuerySepayTransactionDto,
  ) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('cash_flows', 'update')
  @HttpCode(HttpStatus.OK)
  @Post(':id/resolve')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSepayTransactionDto,
  ) {
    return this.service.resolve(user, requireTenantId(user), id, dto);
  }
}
