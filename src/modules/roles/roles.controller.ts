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

/**
 * Chỉ owner được định nghĩa role, và việc này cố ý nằm ngoài catalog quyền: nếu “sửa quyền” là một quyền có thể cấp, role có thể tự cấp nó và leo thang không giới hạn. `OwnerOrAdminGuard` gắn ở từng route chứ không ở class, vì **đọc danh sách khác với sửa**, và có một route cần điều kiện lỏng hơn.
 */
@ApiTags('roles')
@ApiBearerAuth('bearer')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  /**
   * Danh sách role của shop, cho người tuyển hoặc đổi role nhân viên.
   *
   * **Không chỉ owner.** `POST /users` cần `roleId`: manager có `users:create` mà không đọc được danh sách thì không tuyển được ai. `users:update` cũng vậy vì đó là cách chuyển nhân viên sang role khác. Xem tên role không phải là sửa: route chỉ trả role nào tồn tại; đổi thì vẫn cần owner.
   */
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
