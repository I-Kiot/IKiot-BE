import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ShipmentService } from './shipments.service';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { PickUpShipmentDto } from './dto/pick-up-shipment.dto';
import { ChangeDriverDto } from './dto/change-driver.dto';
import { QueryShipmentDto } from './dto/query-shipment.dto';
import { AddShipmentEventDto } from './dto/add-shipment-event.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { QueryDriversDto } from './dto/query-drivers.dto';
import { QueryMyHistoryDto } from './dto/query-my-history.dto';
import { DeliverShipmentDto } from './dto/deliver-shipment.dto';
import { PayCashDto } from './dto/pay-cash.dto';
import { ShipmentDeliveryService } from './shipment-delivery.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';
import { EmitsChange } from '../../common/realtime/emits-change.decorator';
import { ShipmentChanges } from './shipments.change-template';

/** Controller giao hàng; quyền kiểm trong service. */
@ApiTags('shipments')
@ApiBearerAuth('bearer')
@Controller('shipments')
export class ShipmentController {
  constructor(
    private readonly service: ShipmentService,
    private readonly delivery: ShipmentDeliveryService,
  ) {}

  /** Giao cho vận chuyển: ĐVVC ngoài thì PICKED_UP ngay, nội bộ thì chỉ gán shipper. */
  @Post()
  @EmitsChange(ShipmentChanges.created)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateShipmentDto) {
    return this.service.create(user, requireTenantId(user), dto);
  }

  /** Danh sách lần giao người gọi được xem. */
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryShipmentDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  /** Người làm shipper được cho một đơn. */
  @Get('drivers')
  listDrivers(@CurrentUser() user: AuthUser, @Query() query: QueryDriversDto) {
    return this.service.listDrivers(user, requireTenantId(user), query.orderId);
  }

  /** Các lần giao đang mở của người gọi. */
  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.delivery.listMine(user, requireTenantId(user));
  }

  /** Lịch sử giao của tôi. */
  @Get('mine/history')
  listMyHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryMyHistoryDto,
  ) {
    return this.delivery.listMyHistory(user, requireTenantId(user), query);
  }

  /** Shipper xác nhận đã lấy hàng. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pick-up')
  @EmitsChange(ShipmentChanges.pickedUp)
  pickUp(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PickUpShipmentDto,
  ) {
    return this.service.pickUp(user, requireTenantId(user), id, dto);
  }

  /** Giao thành công: ảnh và thu tiền. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/deliver')
  @EmitsChange(ShipmentChanges.delivered)
  deliver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverShipmentDto,
  ) {
    return this.delivery.deliver(user, requireTenantId(user), id, dto);
  }

  /** C-5: đã giao với QR nhưng khách không chuyển – thu tiền mặt thay. Cùng nhóm người như `deliver`. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pay-cash')
  @EmitsChange(ShipmentChanges.cashCollected)
  payCash(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayCashDto,
  ) {
    return this.delivery.payCash(user, requireTenantId(user), id, dto);
  }

  /** Tạo lại mã QR đã hết hạn. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/reissue-qr')
  @EmitsChange(ShipmentChanges.qrReissued)
  reissueQr(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.delivery.reissueQr(user, requireTenantId(user), id);
  }

  /** C-3: chi tiết kèm nhật trình; ngoài phạm vi xem thì 404. */
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  /** Ghi nhật trình "Đang đi giao". */
  @Post(':id/events')
  @EmitsChange(ShipmentChanges.eventAdded)
  addEvent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddShipmentEventDto,
  ) {
    return this.service.addEvent(user, requireTenantId(user), id, dto);
  }

  /** C-3: giao không thành – shipment FAILED, đơn giữ SHIPPING; cùng nhóm người như nhật trình. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/fail')
  @EmitsChange(ShipmentChanges.failed)
  fail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailShipmentDto,
  ) {
    return this.service.fail(user, requireTenantId(user), id, dto);
  }

  /** C-8: đổi shipper / thợ của shipment INTERNAL chưa kết thúc. */
  @Patch(':id/driver')
  @EmitsChange(ShipmentChanges.driverChanged)
  changeDriver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeDriverDto,
  ) {
    return this.service.changeDriver(user, requireTenantId(user), id, dto);
  }
}
