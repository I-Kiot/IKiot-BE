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
import { BranchService } from './branches.service';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { QueryBranchDto } from './dto/query-branch.dto';
import { AssignBranchManagerDto } from './dto/assign-branch-manager.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ported from iKiotMS-BE's branch module. The tenant always comes from the token - no `?tenantId=` override, as in the other hand-ported modules.
@ApiTags('branches')
@ApiBearerAuth('bearer')
@Controller('branches')
export class BranchController {
  constructor(private readonly service: BranchService) {}

  @Permissions('branches', 'read')
  @Get()
  @ApiOperation({ summary: 'Danh sách chi nhánh (phân trang, tìm kiếm)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryBranchDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('branches', 'read')
  @Get(':id')
  @ApiOperation({ summary: 'Chi tiết chi nhánh' })
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('branches', 'create')
  @Post()
  @ApiOperation({
    summary: 'Tạo chi nhánh',
    description:
      'Yêu cầu gói dịch vụ còn hiệu lực và chưa vượt hạn mức số chi nhánh của gói.',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateBranchDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  @Permissions('branches', 'update')
  @Patch(':id')
  @ApiOperation({ summary: 'Cập nhật chi nhánh' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('branches', 'assign_manager')
  @Patch(':id/manager')
  @ApiOperation({
    summary: 'Bổ nhiệm quản lý chi nhánh',
    description:
      'Ghi vào Branch.managerId. Không thay đổi Role của nhân viên - tenant tự quyết quản lý được làm gì.',
  })
  assignManager(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignBranchManagerDto,
  ) {
    return this.service.assignManager(requireTenantId(user), id, dto.staffId);
  }

  @Permissions('branches', 'delete')
  @Delete(':id')
  @ApiOperation({
    summary: 'Xoá chi nhánh (soft delete)',
    description: 'Đặt status = DELETED. Không xoá bản ghi khỏi database.',
  })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(requireTenantId(user), id);
  }
}
