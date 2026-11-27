import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { OwnerOrAdminGuard } from '../../common/guards/owner-or-admin.guard';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Chỉ chủ shop quản lý role. */
@ApiTags('roles')
@ApiBearerAuth('bearer')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  /** Danh sách role, cho cả người có quyền tuyển / sửa nhân viên. */
  @Permissions('users', 'create', 'update')
  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.rolesService.findAll(requireTenantId(user));
  }

  /** Catalog quyền đứng sau màn sửa role; chỉ owner, như chính màn đó. */
  @UseGuards(OwnerOrAdminGuard)
  @Get('permission-catalog')
  permissionCatalog() {
    return this.rolesService.permissionCatalog();
  }

  @UseGuards(OwnerOrAdminGuard)
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rolesService.findOne(requireTenantId(user), id);
  }

  @UseGuards(OwnerOrAdminGuard)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRoleDto) {
    return this.rolesService.create(requireTenantId(user), dto);
  }

  @UseGuards(OwnerOrAdminGuard)
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.update(requireTenantId(user), id, dto);
  }

  @UseGuards(OwnerOrAdminGuard)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rolesService.remove(requireTenantId(user), id);
  }
}
