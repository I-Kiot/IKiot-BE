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

/** Controller két tiền: mở, ghi sổ ca, chốt; không sửa/xoá. */
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

  // `current` khai báo trên `:id` - cả hai đều một đoạn, nên route cố định phải đứng trước.
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get('current')
  current(@CurrentUser() user: AuthUser, @Query() query: CurrentCashDrawerDto) {
    return this.service.current(user, query.branchId);
  }

  /** Két còn mở từ ngày trước của chi nhánh. */
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get('overdue')
  overdue(@CurrentUser() user: AuthUser, @Query() query: CurrentCashDrawerDto) {
    return this.service.overdue(user, query.branchId);
  }

  /** Người nhận được két khi mở két đầu ngày. */
  @Permissions('cash_drawers', 'open')
  @Get('eligible-staff')
  eligibleStaff(
    @CurrentUser() user: AuthUser,
    @Query() query: CurrentCashDrawerDto,
  ) {
    return this.service.eligibleStaff(user, query.branchId);
  }

  /** Báo cáo chênh lệch két theo ngày. */
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

  /** Số đã đếm của một phiên so với sổ quỹ, theo từng ca. */
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get(':id/reconciliation')
  reconcile(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.reconcile(user, id);
  }

  /** Người nhận được bàn giao của phiên này. */
  @Permissions('cash_drawers', 'report')
  @Get(':id/handover-candidates')
  handoverCandidates(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.handoverCandidates(user, id);
  }

  /** Thu ngân nhận két (START) hoặc bàn giao lại (END). */
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
