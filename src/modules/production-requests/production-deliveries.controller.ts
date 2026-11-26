import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  CancelProductionDeliveryDto,
  CreateProductionDeliveryDto,
  QueryProductionDeliveryDto,
  QueryWorkshopProductionRequestDto,
  ReceiveProductionDto,
  CancelProductionRequestByWorkshopDto,
} from './dto/production-request.dto';
import { ProductionDeliveryService } from './production-deliveries.service';
import { EmitsChange } from '../../common/realtime/emits-change.decorator';
import { ProductionChanges } from './production.change-template';

/** Nhân viên xưởng (`users.workshop_id`): xem yêu cầu gửi tới xưởng ở mọi địa điểm và phiếu giao họ viết. Mọi route cần `production:deliver` (tự cấp cho tài khoản gắn xưởng) và xưởng liên kết. */
@ApiTags('workshop')
@ApiBearerAuth('bearer')
@Controller('workshop')
export class WorkshopController {
  constructor(private readonly service: ProductionDeliveryService) {}

  @Permissions('production', 'deliver')
  @Get('production-requests')
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryWorkshopProductionRequestDto,
  ) {
    return this.service.listForWorkshop(user, query);
  }

  @Permissions('production', 'deliver')
  @Get('production-requests/:id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOneForWorkshop(user, id);
  }

  /** Xưởng xác nhận đang làm: từ đây shop không huỷ được YCSX. */
  @Permissions('production', 'deliver')
  @Post('production-requests/:id/accept')
  @HttpCode(200)
  @EmitsChange(ProductionChanges.accepted)
  accept(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.accept(user, id);
  }

  /** Xưởng huỷ YCSX (kèm lý do). Xưởng đã xác nhận đang làm thì chỉ xưởng huỷ được. */
  @Permissions('production', 'deliver')
  @Post('production-requests/:id/cancel')
  @HttpCode(200)
  @EmitsChange(ProductionChanges.declined)
  cancelRequest(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelProductionRequestByWorkshopDto,
  ) {
    return this.service.cancelRequest(user, id, dto);
  }

  @Permissions('production', 'deliver')
  @Post('production-requests/:id/deliveries')
  @EmitsChange(ProductionChanges.deliveryCreated)
  createDelivery(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProductionDeliveryDto,
  ) {
    return this.service.create(user, id, dto);
  }

  @Permissions('production', 'deliver')
  @Get('deliveries')
  deliveries(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryProductionDeliveryDto,
  ) {
    return this.service.list(user, query);
  }

  @Permissions('production', 'deliver')
  @Post('deliveries/:id/cancel')
  @EmitsChange(ProductionChanges.deliveryCancelled)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelProductionDeliveryDto,
  ) {
    return this.service.cancelByWorkshop(user, id, dto);
  }
}

/** Phía nhận phiếu giao của xưởng: danh sách "chờ nhận", xác nhận phiếu (lúc này tồn mới tăng, `production:receive`) hoặc từ chối. */
@ApiTags('production-deliveries')
@ApiBearerAuth('bearer')
@Controller('production-deliveries')
export class ProductionDeliveryController {
  constructor(private readonly service: ProductionDeliveryService) {}

  @Permissions('production_requests', 'read')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryProductionDeliveryDto,
  ) {
    return this.service.list(user, query);
  }

  @Permissions('production_requests', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Permissions('production', 'receive')
  @Post(':id/receive')
  @EmitsChange(ProductionChanges.deliveryReceived)
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveProductionDto,
  ) {
    return this.service.receive(user, id, dto);
  }

  @Permissions('production', 'receive')
  @Post(':id/cancel')
  @EmitsChange(ProductionChanges.deliveryRejected)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelProductionDeliveryDto,
  ) {
    return this.service.cancelByLocation(user, id, dto);
  }
}
