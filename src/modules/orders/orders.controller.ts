import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderService } from './orders.service';
import { SepayOrderService } from './sepay-order.service';
import {
  CreateOrderDto,
  PayOfflineOrderDto,
  QueryOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Real port of OrderController - the same five authenticated routes and permissions, plus the SePay webhook. There is no DELETE: a sale that shouldn't have happened is CANCELLED or RETURNED, both of which leave a trail. */
@ApiTags('orders')
@ApiBearerAuth('bearer')
@Controller('orders')
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Permissions('orders', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.service.create(user, requireTenantId(user), dto);
  }

  @Permissions('orders', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryOrderDto) {
    return this.service.findAll(user, requireTenantId(user), query);
  }

  @Permissions('orders', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.findOne(user, requireTenantId(user), id);
  }

  @Permissions('orders', 'update')
  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.service.updateStatus(
      user,
      requireTenantId(user),
      id,
      dto.status,
    );
  }

  /** Settles a SePay order paid some other way. Either permission is enough, matching the old `authorize("orders", ["update", "pay_offline"])`, so a role holding only `orders:update` doesn't lose it to the port. */
  @Permissions('orders', 'update', 'pay_offline')
  @HttpCode(HttpStatus.OK)
  @Post(':id/pay-offline')
  payOffline(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayOfflineOrderDto,
  ) {
    return this.service.payOffline(
      user,
      requireTenantId(user),
      id,
      user.userId,
      dto,
    );
  }
}

/** The SePay order webhook, on its own controller because its path lives outside `/orders`. It answers 200 for every outcome, since SePay retries anything else; there is no shared secret, because the API key *is* the tenant lookup. */
@ApiTags('orders')
@Controller('webhook/sepay')
export class SepayOrderWebhookController {
  constructor(
    private readonly service: OrderService,
    private readonly sepay: SepayOrderService,
  ) {}

  @RawResponse()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('order')
  async handle(
    @Headers('authorization') authHeader: string | undefined,
    @Body() payload: Record<string, unknown>,
  ) {
    try {
      if (payload.transferType !== 'in') return { success: true };

      // SePay sends "Apikey <key>", not "Bearer <key>".
      const apiKey = authHeader?.replace(/^Apikey\s+/i, '').trim() ?? '';
      const tenant = await this.sepay.findTenantByWebhookKey(apiKey);
      if (!tenant) return { success: false, message: 'Unknown API key' };

      const reference = this.sepay.extractOrderReference(
        typeof payload.content === 'string' ? payload.content : '',
      );
      if (!reference) {
        return { success: false, message: 'No order reference found' };
      }

      // SePay sends its transaction id as a number; `null` rather than `''` for a malformed call, since an empty string would read as "we have the id" to anyone reconciling.
      const transactionId =
        typeof payload.id === 'string' || typeof payload.id === 'number'
          ? String(payload.id)
          : null;

      const order = await this.service.completeSepayOrder(
        tenant.id,
        reference,
        transactionId,
        Number(payload.transferAmount ?? 0),
      );
      return order
        ? { success: true, message: 'Order payment confirmed' }
        : { success: false, message: 'Order not found or already processed' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
