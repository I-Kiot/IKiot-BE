import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { HolidayService } from './holidays.service';
import { HolidaySyncService } from './holiday-sync.service';
import {
  CreateHolidayDto,
  QueryHolidayDto,
  SyncVietnamHolidayDto,
  ToggleHolidayStatusDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Six routes at the old paths and permissions (`:holidayId` renamed `:id` to match every other module); the sync route is gated on `holidays:update`, since it refreshes rows the tenant already owns. */
@ApiTags('holidays')
@ApiBearerAuth('bearer')
@Controller('holidays')
export class HolidayController {
  constructor(
    private readonly service: HolidayService,
    private readonly sync: HolidaySyncService,
  ) {}

  @Permissions('holidays', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryHolidayDto) {
    return this.service.findAll(requireTenantId(user), query);
  }

  @Permissions('holidays', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateHolidayDto) {
    return this.service.create(requireTenantId(user), dto);
  }

  // Declared above `:id` - `sync` would otherwise be matched as a holiday id.
  @Permissions('holidays', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('sync/vietnam')
  syncVietnam(
    @CurrentUser() user: AuthUser,
    @Body() dto: SyncVietnamHolidayDto,
  ) {
    return this.sync.syncVietnamPublicHolidays(requireTenantId(user), dto.year);
  }

  @Permissions('holidays', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
  ) {
    return this.service.update(requireTenantId(user), id, dto);
  }

  @Permissions('holidays', 'update')
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ToggleHolidayStatusDto,
  ) {
    return this.service.updateStatus(requireTenantId(user), id, dto);
  }

  @Permissions('holidays', 'delete')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(requireTenantId(user), id);
  }
}
