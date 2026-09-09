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
  LeaveBalanceDto,
  StaffAccountPasswordDto,
} from './dto/staff-account.dto';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Staff accounts - iKiotMS-BE's `/staff` module, at `/users`, keeping the old sub-paths for leave balance and the account lifecycle. The old `GET /staff/roles` is not reproduced: roles are tenant-defined rows, so `GET /roles` is the answer. All of these are `users:update` rather than `staff:update`, since two catalog resources for one thing is how a permission ends up granted in one place and checked in the other. */
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

  // ─── Account lifecycle ─────────────────────────────────────────────────────

  /** Switch on the login for an employee who was recorded without one. */
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

  // ─── Leave balance ─────────────────────────────────────────────────────────

  /** Change the yearly allowance, keeping days already taken. */
  @Permissions('users', 'update')
  @Patch(':id/leave-balance')
  updateLeaveBalance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaveBalanceDto,
  ) {
    return this.usersService.updateLeaveBalance(requireTenantId(user), id, dto);
  }

  /** Set the opening balance - only valid while nothing has been taken yet. */
  @Permissions('users', 'update')
  @Post(':id/leave-balance')
  createLeaveBalance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaveBalanceDto,
  ) {
    return this.usersService.createLeaveBalance(requireTenantId(user), id, dto);
  }
}
