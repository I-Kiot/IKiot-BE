import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AttendanceService } from './attendances.service';
import {
  CheckInDto,
  CheckOutDto,
  CreateManualAttendanceDto,
  ManualCheckoutDto,
  QueryAttendanceDto,
} from './dto/attendance.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

@ApiTags('attendances')
@ApiBearerAuth('bearer')
@Controller('attendances')
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}

  @Permissions('attendances', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryAttendanceDto) {
    return this.service.findAll(user, query);
  }

  @Permissions('attendances', 'read_own')
  @Get('me')
  findMine(@CurrentUser() user: AuthUser, @Query() query: QueryAttendanceDto) {
    return this.service.findMine(user, query);
  }

  @Permissions('attendances', 'read', 'read_own')
  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user, id);
  }

  @Permissions('attendances', 'create')
  @Post('check-in')
  checkIn(@CurrentUser() user: AuthUser, @Body() dto: CheckInDto) {
    return this.service.checkIn(user, dto);
  }

  @Permissions('attendances', 'checkout_own')
  @HttpCode(HttpStatus.OK)
  @Post('check-out')
  checkOut(@CurrentUser() user: AuthUser, @Body() dto: CheckOutDto) {
    return this.service.checkOut(user, dto);
  }

  @Permissions('attendances', 'update')
  @Post('manual')
  createManual(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateManualAttendanceDto,
  ) {
    return this.service.createManual(user, dto);
  }

  @Permissions('attendances', 'update')
  @Patch(':id/manual-checkout')
  manualCheckout(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ManualCheckoutDto,
  ) {
    return this.service.manualCheckout(user, id, dto);
  }
}
