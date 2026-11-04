import {
  Body,
  Controller,
  Get,
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
} from './dto/production-request.dto';
import { ProductionDeliveryService } from './production-deliveries.service';

/** Nhân viên xưởng (`users.workshop_id`): xem yêu cầu gửi tới xưởng ở mọi địa điểm và phiếu giao họ viết. Mọi route cần `production:deliver` và xưởng liên kết. */
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

  @Permissions('production', 'deliver')
  @Post('production-requests/:id/deliveries')
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
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveProductionDto,
  ) {
    return this.service.receive(user, id, dto);
  }

  @Permissions('production', 'receive')
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelProductionDeliveryDto,
  ) {
    return this.service.cancelByLocation(user, id, dto);
  }
}
