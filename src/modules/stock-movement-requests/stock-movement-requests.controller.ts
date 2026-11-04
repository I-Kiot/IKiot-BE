import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StockMovementService } from './stock-movement-requests.service';
import {
  CreateStockMovementDto,
  QueryStockMovementDto,
  ReceiveMovementDto,
  UpdateMovementDetailsDto,
} from './dto/stock-movement.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Port của StockMovementController, cùng path và permission. Không có DELETE: phiếu là chứng từ, nên huỷ chứ không xoá. */
@ApiTags('stock-movements')
@ApiBearerAuth('bearer')
@Controller('stock-movements')
export class StockMovementController {
  constructor(private readonly service: StockMovementService) {}

  @Permissions('stock_movement', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStockMovementDto) {
    return this.service.create(user, dto);
  }

  @Permissions('stock_movement', 'read')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryStockMovementDto,
  ) {
    return this.service.findAll(user, query);
  }

  @Permissions('stock_movement', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Permissions('stock_movement', 'update')
  @Patch(':id/details')
  updateDetails(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMovementDetailsDto,
  ) {
    return this.service.updateDetails(user, id, dto);
  }

  @Permissions('stock_movement', 'update')
  @Patch(':id/open')
  open(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.open(user, id);
  }

  @Permissions('stock_movement', 'update')
  @Patch(':id/close')
  close(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.close(user, id);
  }

  /** → IN_TRANSIT. Hàng rời nguồn tại đây. */
  @Permissions('stock_movement', 'approve')
  @Patch(':id/ship')
  ship(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.ship(user, id);
  }

  /** → RECEIVED. Hàng về, và phiếu nhập ghi nhận công nợ NCC. */
  @Permissions('stock_movement', 'receive')
  @Patch(':id/receive')
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveMovementDto,
  ) {
    return this.service.receive(user, id, dto);
  }

  @Permissions('stock_movement', 'approve')
  @Patch(':id/approve-adjust')
  approveAdjust(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.approveAdjust(user, id);
  }

  @Permissions('stock_movement', 'cancel')
  @Patch(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(user, id);
  }
}
