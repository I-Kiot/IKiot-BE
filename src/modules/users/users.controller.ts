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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUserDto } from './dto/query-user.dto';
import {
  DeleteStaffDto,
  StaffAccountPasswordDto,
} from './dto/staff-account.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Nhân viên, nằm ở `/users`, giữ các sub-path của vòng đời tài khoản. Không có `GET /staff/roles` cũ: role là row do tenant định nghĩa, dùng `GET /roles`. Tất cả dùng `users:update` thay vì `staff:update`: hai resource cho cùng một việc sẽ khiến quyền cấp ở chỗ này và kiểm tra ở chỗ khác. */
@ApiTags('users')
@ApiBearerAuth('bearer')
@Controller('users')
export class UserController {
  constructor(private readonly usersService: UserService) {}

  @Permissions('users', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryUserDto) {
    return this.usersService.findAll(requireTenantId(user), user.userId, query);
  }

  @Permissions('users', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.findOne(requireTenantId(user), id);
  }

  @Permissions('users', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.usersService.create(user, requireTenantId(user), dto);
  }

  @Permissions('users', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(user, requireTenantId(user), id, dto);
  }

  @Permissions('users', 'delete')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteStaffDto,
  ) {
    return this.usersService.remove(
      user,
      requireTenantId(user),
      id,
      user.userId,
      dto,
    );
  }

  @Permissions('users', 'update')
  @Post(':id/account')
  createAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffAccountPasswordDto,
  ) {
    return this.usersService.createAccount(
      user,
      requireTenantId(user),
      id,
      dto,
    );
  }

  @Permissions('users', 'update')
  @Patch(':id/account/password')
  updateAccountPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffAccountPasswordDto,
  ) {
    return this.usersService.updateAccountPassword(
      user,
      requireTenantId(user),
      id,
      dto,
    );
  }

  @Permissions('users', 'update')
  @Patch(':id/account/deactivate')
  deactivateAccount(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.deactivateAccount(user, requireTenantId(user), id);
  }
}
