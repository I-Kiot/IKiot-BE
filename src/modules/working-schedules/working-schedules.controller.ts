import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { WorkingScheduleService } from './working-schedules.service';
import {
  BulkCreateWorkingScheduleDto,
  QueryWorkingScheduleDto,
  UpdateWorkingScheduleDto,
} from './dto/working-schedule.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Ten routes at the old paths and permissions, including the four actions the old module named (`read_all`, `readBR`, `readWH`, `read`/`read_own`). `current`, `me`, `branches` and `warehouses` are declared above `:id` or they get matched as schedule ids. */
@ApiTags('working-schedules')
@ApiBearerAuth('bearer')
@Controller('working-schedules')
export class WorkingScheduleController {
  constructor(private readonly service: WorkingScheduleService) {}

  @Permissions('schedules', 'read_all')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryWorkingScheduleDto,
  ) {
    return this.service.findAll(requireTenantId(user), query);
  }

  /** The shift the caller is in right now, or `{ data: null }`. */
  @Permissions('schedules', 'read', 'read_own')
  @Get('current')
  findCurrent(@CurrentUser() user: AuthUser) {
    return this.service.findCurrent(requireTenantId(user), user.userId);
  }

  @Permissions('schedules', 'read', 'read_own')
  @Get('me')
  findMine(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryWorkingScheduleDto,
  ) {
    return this.service.findMine(requireTenantId(user), user.userId, query);
  }

  /** The branch and warehouse views are the same list with the location pinned; the old routes answered 400 without the id, and `QueryWorkingScheduleDto` makes that a validation error instead. */
  @Permissions('schedules', 'readBR')
  @Get('branches')
  findByBranch(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryWorkingScheduleDto,
  ) {
    return this.service.findByLocation(requireTenantId(user), query, 'branch');
  }

  @Permissions('schedules', 'readWH')
  @Get('warehouses')
  findByWarehouse(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryWorkingScheduleDto,
  ) {
    return this.service.findByLocation(
      requireTenantId(user),
      query,
      'warehouse',
    );
  }

  @Permissions('schedules', 'create')
  @Post('bulk')
  createBulk(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkCreateWorkingScheduleDto,
  ) {
    return this.service.createBulk(requireTenantId(user), user.userId, dto);
  }

  @Permissions('schedules', 'read', 'read_own')
  @Get(':id/users/:userId')
  findUserDetail(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.service.findUserDetail(requireTenantId(user), id, userId);
  }

  @Permissions('schedules', 'read', 'read_own')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(requireTenantId(user), id);
  }

  @Permissions('schedules', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateWorkingScheduleDto,
  ) {
    return this.service.update(requireTenantId(user), user.userId, id, dto);
  }

  @Permissions('schedules', 'delete')
  @Delete(':id/users/:userId')
  removeUser(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.service.removeUser(requireTenantId(user), id, userId);
  }

  @Permissions('schedules', 'delete')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(requireTenantId(user), id);
  }
}
