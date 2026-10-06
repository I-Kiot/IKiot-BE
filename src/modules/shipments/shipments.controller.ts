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
import { ChangeDriverDto } from './dto/change-driver.dto';
import { QueryShipmentDto } from './dto/query-shipment.dto';
import { AddShipmentEventDto } from './dto/add-shipment-event.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
import { QueryDriversDto } from './dto/query-drivers.dto';
import { DeliverShipmentDto } from './dto/deliver-shipment.dto';
import { PayCashDto } from './dto/pay-cash.dto';
import { ShipmentDeliveryService } from './shipment-delivery.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/**
 * Lấy hàng & giao hàng (contract §4). Mọi route dưới đây **cố ý không có `@Permissions`**: người phụ
 * trách đơn làm được mọi bước của đơn mình mà không cần quyền trong role, shipper xem và ghi nhật trình
 * shipment của mình (chốt 2026-10-06), và guard chạy trước khi biết đơn / shipment là của ai. Quyền được
 * kiểm trong service: `assertOrderStepAccess` cho các bước của đơn, `visibleWhere` cho việc xem,
 * `deliveryActorAccess` cho giao xong / thu tiền.
 */
@ApiTags('shipments')
@ApiBearerAuth('bearer')
@Controller('shipments')
export class ShipmentController {
  constructor(
    private readonly service: ShipmentService,
    private readonly delivery: ShipmentDeliveryService,
  ) {}

  /** C-2 + C-8: "ĐVVC đã lấy hàng" – đơn PACKED → PICKED_UP, gán shipper nếu giao nội bộ. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateShipmentDto) {
    return this.service.create(user, requireTenantId(user), dto);
  }

  /** C-3: danh sách shipment người gọi được xem – chủ shop, người phụ trách đơn, shipper, hoặc `shipments:read` tại kho xuất / chi nhánh bán. */
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryShipmentDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  /** C-9: người làm shipper được cho một đơn (ô chọn shipper). Phải khai báo TRÊN `GET :id`, nếu không "drivers" bị hiểu là một id. */
  @Get('drivers')
  listDrivers(@CurrentUser() user: AuthUser, @Query() query: QueryDriversDto) {
    return this.service.listDrivers(user, requireTenantId(user), query.orderId);
  }

  /** C-5: các lần giao chưa kết thúc mà người gọi là shipper. Phải khai báo TRÊN `GET :id`, như `drivers`. */
  @Get('mine')
  listMine(@CurrentUser() user: AuthUser) {
    return this.delivery.listMine(user, requireTenantId(user));
  }

  /** C-5: giao thành công – ảnh bằng chứng + thu tiền (tiền mặt / QR / đã cọc đủ). Shipper, người phụ trách đơn, chủ shop. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/deliver')
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
  payCash(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayCashDto,
  ) {
    return this.delivery.payCash(user, requireTenantId(user), id, dto);
  }

  /** C-3: chi tiết kèm nhật trình; ngoài phạm vi xem thì 404. */
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  /** C-3: ghi nhật trình "Đang đi giao" – chủ shop, người phụ trách, shipper, hoặc `shipments:update` tại kho của fulfillment. */
  @Post(':id/events')
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
  fail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FailShipmentDto,
  ) {
    return this.service.fail(user, requireTenantId(user), id, dto);
  }

  /** C-8: đổi shipper / thợ của shipment INTERNAL chưa kết thúc. */
  @Patch(':id/driver')
  changeDriver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeDriverDto,
  ) {
    return this.service.changeDriver(user, requireTenantId(user), id, dto);
  }
}
