import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CashDrawerSessionService } from './cash-drawer-sessions.service';
import {
  CurrentCashDrawerDto,
  FinalizeCashDrawerDto,
  OpenCashDrawerDto,
  QueryCashDrawerDto,
  QueryCashVarianceDto,
  SubmitShiftLogDto,
} from './dto/cash-drawer.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Real port of CashDrawerController - same six routes and permissions, with the three reads taking `cash_drawers:read` **or** `read_own`. There is deliberately no PATCH or DELETE: a till session is opened, logged and finalised, never edited. */
@ApiTags('cash-drawer-sessions')
@ApiBearerAuth('bearer')
@Controller('cash-drawer-sessions')
export class CashDrawerSessionController {
  constructor(private readonly service: CashDrawerSessionService) {}

  @Permissions('cash_drawers', 'open')
  @Post()
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenCashDrawerDto) {
    return this.service.open(user, dto);
  }

  // `current` is declared above `:id` - both are one segment deep, so the literal has to come first.
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get('current')
  current(@CurrentUser() user: AuthUser, @Query() query: CurrentCashDrawerDto) {
    return this.service.current(user, query.branchId);
  }

  /** The variance report - which trading days did not balance. Above `:id` because both are one segment deep, and under the same `read`/`read_own` narrowing, so it can never show a session the caller could not already open. */
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get('reconciliation')
  report(@CurrentUser() user: AuthUser, @Query() query: QueryCashVarianceDto) {
    return this.service.report(user, query);
  }

  @Permissions('cash_drawers', 'read', 'read_own')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryCashDrawerDto) {
    return this.service.findAll(user, query);
  }

  @Permissions('cash_drawers', 'read', 'read_own')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  /** One session's counted amounts against the cash the ledger says moved, per shift - the subtraction the shift logs always implied and nothing ever performed. */
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get(':id/reconciliation')
  reconcile(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.reconcile(user, id);
  }

  /** A cashier taking the drawer (START) or handing it back (END). */
  @Permissions('cash_drawers', 'report')
  @HttpCode(HttpStatus.OK)
  @Post(':id/shift-logs')
  submitShiftLog(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitShiftLogDto,
  ) {
    return this.service.submitShiftLog(user, id, dto);
  }

  /** Closes the day with a counted total. */
  @Permissions('cash_drawers', 'finalize')
  @HttpCode(HttpStatus.OK)
  @Post(':id/finalize')
  finalize(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeCashDrawerDto,
  ) {
    return this.service.finalize(user, id, dto);
  }
}
