import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  CreateProductionRequestDto,
  ProductionRequestLineDto,
  QueryProductionListDto,
  QueryProductionRequestDto,
  ReceiveProductionDto,
  UpdateProductionRequestDto,
  UpdateProductionRequestStatusDto,
} from './dto/production-request.dto';
import { ProductionListService } from './production-list.service';
import { ProductionRequestService } from './production-requests.service';

/** "Yêu cầu sản xuất" (YCSX) sent to a WORKSHOP supplier and tracked by hand (hành trình GĐ1 – Bước 4, contract §3). Receiving the goods is its own right, `production:receive`, because it is what raises stock. Every route takes the whole `AuthUser`: where the caller works decides what they may touch. */
@ApiTags('production-requests')
@ApiBearerAuth('bearer')
@Controller('production-requests')
export class ProductionRequestController {
  constructor(private readonly service: ProductionRequestService) {}

  @Permissions('production_requests', 'read')
  @Get()
  findAll(
    @CurrentUser() user: AuthUser,
    @Query() query: QueryProductionRequestDto,
  ) {
    return this.service.findAll(user, query);
  }

  @Permissions('production_requests', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, id);
  }

  @Permissions('production_requests', 'create')
  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductionRequestDto,
  ) {
    return this.service.create(user, dto);
  }

  @Permissions('production_requests', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductionRequestDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Permissions('production_requests', 'update')
  @Post(':id/items')
  addItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProductionRequestLineDto,
  ) {
    return this.service.addItem(user, id, dto);
  }

  @Permissions('production_requests', 'update')
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductionRequestStatusDto,
  ) {
    return this.service.updateStatus(user, id, dto);
  }

  @Permissions('production_requests', 'delete')
  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user, id);
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
}

/** "Danh sách cần sản xuất": computed on every read from the open orders, the stock and the open production requests - there is no table behind it (contract §3). */
@ApiTags('production-list')
@ApiBearerAuth('bearer')
@Controller('production-list')
export class ProductionListController {
  constructor(private readonly service: ProductionListService) {}

  @Permissions('production_requests', 'read')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: QueryProductionListDto) {
    return this.service.list(user, query);
  }
}
