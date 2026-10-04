import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FulfillmentService } from './fulfillments.service';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  CancelFulfillmentDto,
  CreateFulfillmentDto,
  CreatePackageDto,
  UpdateFulfillmentItemsDto,
} from './dto/fulfillment.dto';

/** Packing a READY_TO_PACK order. Verifying the packed goods is what deducts the stock, through InventoryService.consume (docs/order-flow.md B5). Shell created in Phase 0 (P0-4); the routes are track C (kieudang)'s, written against docs/api-contract-order-flow.md. Every route needs its own @Permissions. */
@ApiTags('fulfillments')
@ApiBearerAuth('bearer')
@Controller('fulfillments')
export class FulfillmentController {
  constructor(private readonly service: FulfillmentService) {}

  @Permissions('fulfillments', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateFulfillmentDto) {
    return this.service.createFulfillment(user, dto);
  }

  @Permissions('fulfillments', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findFulfillmentById(user, id);
  }

  @Permissions('fulfillments', 'update')
  @Patch(':id/items')
  updateItems(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFulfillmentItemsDto,
  ) {
    return this.service.updateFulfillmentItems(user, id, dto);
  }

  @Permissions('fulfillments', 'update')
  @Post(':id/packages')
  addPackage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePackageDto,
  ) {
    return this.service.addFulfillmentPackage(user, id, dto);
  }

  // No @Permissions on purpose: fulfillments:verify OR the order's person in charge, checked in FulfillmentService.verify.
  @Post(':id/verify')
  @HttpCode(200)
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.verifyFulfillmentAndLockStock(user, id);
  }

  @Permissions('fulfillments', 'update')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelFulfillmentDto,
  ) {
    return this.service.cancelFulfillment(user, id, dto);
  }
}
