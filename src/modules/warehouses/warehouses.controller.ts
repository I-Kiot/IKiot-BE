import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WarehouseService } from './warehouses.service';
import { CreateWarehouseDto } from './dto/create-warehouse.dto';
import { UpdateWarehouseDto } from './dto/update-warehouse.dto';
import { QueryWarehouseDto } from './dto/query-warehouse.dto';
import { AssignWarehouseManagerDto } from './dto/assign-warehouse-manager.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ported from iKiotMS-BE's warehouse module - same route surface as branches.
@ApiTags('warehouses')
@ApiBearerAuth('bearer')
@Controller('warehouses')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Permissions('warehouses', 'read')
  @Get()
  @ApiOperation({ summary: 'Danh sách kho (phân trang, tìm kiếm)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryWarehouseDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('warehouses', 'read')
  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết kho' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('warehouses', 'create')
  @Post()
  @ApiOperation({
    summary: 'Tạo kho',
    description:
      'Yêu cầu gói dịch vụ còn hiệu lực và chưa vượt hạn mức số kho của gói.',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWarehouseDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('warehouses', 'update')
  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật kho' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('warehouses', 'assign_manager')
  @Patch(':id/manager')
  @ApiOperation({
    summary: 'Bổ nhiệm quản lý kho',
    description:
      'Ghi vào Warehouse.managerId. Không thay đổi Role của nhân viên - tenant tự quyết quản lý được làm gì.',
  })
  assignManager(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignWarehouseManagerDto,
  ) {
    return this.service.assignManager(requireTenantId(user), id, dto.staffId);
  }

  @Permissions('warehouses', 'delete')
  @Delete(':id')
  @ApiOperation({
    summary: 'Xoá kho (soft delete)',
    description: 'Đặt status = DELETED. Không xoá bản ghi khỏi database.',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
