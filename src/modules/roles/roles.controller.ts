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
 * Defining roles is owner-only and deliberately outside the permission catalogue: if "edit
 * permissions" were itself grantable, a custom role could grant it to itself and escalate
 * without limit. `OwnerOrAdminGuard` therefore sits on each route rather than on the class -
 * because **reading the list is a different question from editing it**, and one route needs
 * the looser answer.
 */
@ApiTags('roles')
@ApiBearerAuth('bearer')
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  /**
   * The shop's roles, for whoever hires or reassigns staff.
   *
   * **Not owner-only**, unlike everything else here. `POST /users` requires a `roleId`, so a
   * manager holding `users:create` who cannot read this list cannot hire anybody - the form's
   * dropdown comes back empty and there is no id to send. Same for `users:update`, which is
   * how somebody is moved to another role. Naming a role is not editing one: this answers
   * which roles exist and what each may do; changing that still takes the owner.
   */
  @Permissions('users', 'create', 'update')
  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.rolesService.findAll(requireTenantId(user));
  }

  /** The 150-pair catalogue behind the role editor - owner-only, like the editor itself. */
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
