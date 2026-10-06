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
import { IsUUID } from 'class-validator';
import { OrderReturnService } from './order-returns.service';
import {
  CreateOrderReturnDto,
  InspectOrderReturnDto,
  QueryOrderReturnDto,
} from './dto/order-return.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

class SetReplacementOrderDto {
  @IsUUID()
  orderId: string;
}

/** "Đơn hoàn hàng", opened by hand for any channel; GOOD lines go back to a sellable location, DAMAGED ones to its damaged-goods location (contract §5, D-5). */
@ApiTags('order-returns')
@ApiBearerAuth('bearer')
@Controller('order-returns')
export class OrderReturnController {
  constructor(private readonly service: OrderReturnService) {}

  @Permissions('returns', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryOrderReturnDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  @Permissions('returns', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  /** No @Permissions on purpose: `returns:create` OR the order's person in charge may open one, which a single guard action cannot say - the service checks it (ORDER_RETURN_DENIED). */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderReturnDto) {
    return this.service.create(user, requireTenantId(user), dto);
  }

  @Permissions('returns', 'inspect')
  @HttpCode(HttpStatus.OK)
  @Post(':id/receive')
  receive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.receive(user, requireTenantId(user), id);
  }

  @Permissions('returns', 'inspect')
  @HttpCode(HttpStatus.OK)
  @Post(':id/inspect')
  inspect(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InspectOrderReturnDto,
  ) {
    return this.service.inspect(user, requireTenantId(user), id, dto);
  }

  @Permissions('returns', 'cancel')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.cancel(user, requireTenantId(user), id);
  }

  @Permissions('returns', 'create')
  @Patch(':id/replacement-order')
  setReplacementOrder(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetReplacementOrderDto,
  ) {
    return this.service.setReplacementOrder(
      user,
      requireTenantId(user),
      id,
      dto.orderId,
    );
  }
}
