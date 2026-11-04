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

/** Cùng sáu route và permission như CashDrawerController; ba route đọc nhận `cash_drawers:read` **hoặc** `read_own`. Cố ý không có PATCH/DELETE: phiên két chỉ mở, ghi log và chốt, không sửa. */
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

  /** Báo cáo chênh lệch - những ngày nào không khớp. Khai báo trên `:id` vì cả hai đều một đoạn, và chịu cùng phạm vi `read`/`read_own`, nên không bao giờ lộ phiên mà caller không mở được. */
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

  /** Số đã đếm của một phiên so với tiền sổ quỹ ghi nhận, theo từng ca: phép trừ mà shift log luôn ngầm định nhưng chưa từng được thực hiện. */
  @Permissions('cash_drawers', 'read', 'read_own')
  @Get(':id/reconciliation')
  reconcile(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.reconcile(user, id);
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
