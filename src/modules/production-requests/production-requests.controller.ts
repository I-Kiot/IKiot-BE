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
import { EmitsChange } from '../../common/realtime/emits-change.decorator';
import { ProductionChanges } from './production.change-template';

/** Controller YCSX gửi xưởng. */
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
  @EmitsChange(ProductionChanges.created)
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductionRequestDto,
  ) {
    return this.service.create(user, dto);
  }

  @Permissions('production_requests', 'update')
  @Patch(':id')
  @EmitsChange(ProductionChanges.edited)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductionRequestDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Permissions('production_requests', 'update')
  @Post(':id/items')
  @EmitsChange(ProductionChanges.itemAdded)
  addItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProductionRequestLineDto,
  ) {
    return this.service.addItem(user, id, dto);
  }

  @Permissions('production_requests', 'update')
  @Patch(':id/status')
  @EmitsChange(ProductionChanges.statusChanged)
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductionRequestStatusDto,
  ) {
    return this.service.updateStatus(user, id, dto);
  }

  @Permissions('production_requests', 'delete')
  @Delete(':id')
  @EmitsChange(ProductionChanges.deleted)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remove(user, id);
  }

  @Permissions('production', 'receive')
  @Post(':id/receive')
  @EmitsChange(ProductionChanges.received)
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveProductionDto,
  ) {
    return this.service.receive(user, id, dto);
  }
}

/** Danh sách cần sản xuất. */
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
