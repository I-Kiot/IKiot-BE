import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { LeaveRequestService } from './leave-requests.service';
import {
  CreateEmergencyLeaveRequestDto,
  CreateLeaveRequestDto,
  PreviewHandoverDto,
  QueryLeavePerDayDto,
  QueryLeaveRequestDto,
  ReviewLeaveRequestDto,
} from './dto/leave-request.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { LeaveRequestStatus } from './leave-request.constants';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Twelve routes at the old paths and permissions. `me`, `me/per-day`, `balance`, `branches`, `warehouses` and `handover/preview` are declared above `:id` or they get matched as request ids. `POST /leave-requests` carries no `@Permissions`, as the old route didn't: everybody may file their own leave. */
@ApiTags('leave-requests')
@ApiBearerAuth('bearer')
@Controller('leave-requests')
export class LeaveRequestController {
  constructor(private readonly service: LeaveRequestService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeaveRequestDto) {
    return this.service.create(user, dto);
  }

  /** Which of the caller's shifts a proposed leave window would strand. */
  @HttpCode(HttpStatus.OK)
  @Post('handover/preview')
  previewHandover(
    @CurrentUser() user: AuthUser,
    @Body() dto: PreviewHandoverDto,
  ) {
    return this.service.previewHandover(user, dto);
  }

  @Permissions('leaveRequests', 'read_mine')
  @Get('me')
  findMine(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryLeaveRequestDto,
  ) {
    return this.service.findMine(user, query);
  }

  @Permissions('leaveRequests', 'read_mine')
  @Get('me/per-day')
  findMinePerDay(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryLeavePerDayDto,
  ) {
    return this.service.findMinePerDay(user, query);
  }

  @Permissions('leaveRequests', 'read_mine')
  @Get('balance')
  balance(@CurrentUser() user: AuthUser) {
    return this.service.balanceOf(user);
  }

  @Permissions('leaveRequests', 'read_all')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryLeaveRequestDto) {
    return this.service.findAll(user, query);
  }

  // The branch and warehouse views are the same list with the location pinned, as the old pair of near-identical handlers were.
  @Permissions('leaveRequests', 'readBR')
  @Get('branches')
  findByBranch(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryLeaveRequestDto,
  ) {
    return this.service.findAll(user, query);
  }

  @Permissions('leaveRequests', 'readWH')
  @Get('warehouses')
  findByWarehouse(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryLeaveRequestDto,
  ) {
    return this.service.findAll(user, query);
  }

  @Permissions('leaveRequests', 'create_emergency')
  @Post('emergency')
  createEmergency(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEmergencyLeaveRequestDto,
  ) {
    return this.service.createEmergency(user, dto);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Permissions('leaveRequests', 'approve')
  @HttpCode(HttpStatus.OK)
  @Post(':id/approve')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviewLeaveRequestDto,
  ) {
    return this.service.review(user, id, LeaveRequestStatus.APPROVED, dto);
  }

  @Permissions('leaveRequests', 'reject')
  @HttpCode(HttpStatus.OK)
  @Post(':id/reject')
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviewLeaveRequestDto,
  ) {
    return this.service.review(user, id, LeaveRequestStatus.REJECTED, dto);
  }

  @Permissions('leaveRequests', 'cancel')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.cancel(user, id);
  }
}
