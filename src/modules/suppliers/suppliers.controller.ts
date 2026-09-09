import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SupplierService } from './suppliers.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';
import { QuerySupplierDto } from './dto/query-supplier.dto';
import { PaySupplierDebtDto } from './dto/pay-supplier-debt.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ported from the supplier module - the only product-attribute module that carries real business logic (payables).
@ApiTags('suppliers')
@ApiBearerAuth('bearer')
@Controller('suppliers')
export class SupplierController {
  constructor(private readonly service: SupplierService) {}

  @Permissions('suppliers', 'read')
  @Get()
  @ApiOperation({
    summary: 'Danh sách nhà cung cấp',
    description:
      'Tìm theo tên/số điện thoại, lọc `hasDebt=true` để xem bên còn nợ.',
  })
  findAll(@CurrentUser() user: AuthUser, @Query() query: QuerySupplierDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('suppliers', 'read')
  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết nhà cung cấp' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('suppliers', 'create')
  @Post()
  @ApiOperation({
    summary: 'Tạo nhà cung cấp',
    description: 'Công nợ luôn bắt đầu từ 0, không nhận từ client.',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('suppliers', 'update')
  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật nhà cung cấp' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('suppliers', 'pay_debt')
  @Post(':id/payments')
  // 200, not Nest's default 201 for POST: iKiotMS-BE answered 200 here and the frontend checks the status code.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Thanh toán công nợ nhà cung cấp',
    description:
      'Giảm công nợ và ghi một phiếu chi (CashFlow EXPENSE) trong cùng một transaction, sau đó thông báo cho chủ cửa hàng.',
  })
  payDebt(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PaySupplierDebtDto,
  ) {
    return this.service.payDebt(requireTenantId(user), user.userId, id, dto);
  }

  @Permissions('suppliers', 'delete')
  @Delete(':id')
  @ApiOperation({
    summary: 'Xoá nhà cung cấp',
    description:
      'Chỉ xoá được khi không còn công nợ và chưa phát sinh giao dịch.',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
