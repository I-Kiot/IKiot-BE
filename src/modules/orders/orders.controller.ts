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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrderService } from './orders.service';
import { SepayOrderService } from './sepay-order.service';
import { ManualOrderService } from './manual-order.service';
import { OrderCancelService } from './order-cancel.service';
import { OrderEditService } from './order-edit.service';
import { OrderCustomizationService } from './order-customization.service';
import { OrderItemCustomizationDto } from './dto/order-item-customization.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import {
  SetOrderAssigneeDto,
  SetOrderPriorityDto,
  UpdateOrderDto,
} from './dto/update-order.dto';
import {
  CreatePosOrderDto,
  PayOfflineOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { PackOrderDto } from './dto/pack-order.dto';
import { QueryOrderJourneyDto } from './dto/query-order-journey.dto';
import { OrderReadService } from './order-read.service';
import { FulfillmentService } from '../fulfillments/fulfillments.service';
import { ShipmentService } from '../shipments/shipments.service';
import { ShipmentDeliveryService } from '../shipments/shipment-delivery.service';
import { ShipOrderDto } from '../shipments/dto/ship-order.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Real port of OrderController plus the order journey's routes, and the SePay webhook. There is no DELETE: a sale that shouldn't have happened is CANCELLED or RETURNED, both of which leave a trail. */
@ApiTags('orders')
@ApiBearerAuth('bearer')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly service: OrderService,
    private readonly fulfillments: FulfillmentService,
    private readonly shipments: ShipmentService,
    private readonly manualOrders: ManualOrderService,
    private readonly cancels: OrderCancelService,
    private readonly reads: OrderReadService,
    private readonly edits: OrderEditService,
    private readonly customizations: OrderCustomizationService,
  ) {}

  /** A-2: a manual order in the order journey, born CONFIRMED with a person in charge (contract §2). */
  @Permissions('orders', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.manualOrders.create(user, requireTenantId(user), dto);
  }

  /** The till's sale: paid and deducted on the spot, outside the journey. It was `POST /orders` until A-2 gave that route to the journey. */
  @Permissions('orders', 'create')
  @Post('pos')
  createPosSale(@CurrentUser() user: AuthUser, @Body() dto: CreatePosOrderDto) {
    return this.service.createPosSale(user, requireTenantId(user), dto);
  }

  /** A-9: the order-journey list (contract §2), a superset of what POS reads off it. */
  @Permissions('orders', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryOrderJourneyDto) {
    return this.reads.findAll(user, requireTenantId(user), query);
  }

  /** A-9: `OrderDetail` (contract §2). */
  @Permissions('orders', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reads.findOne(user, requireTenantId(user), id);
  }

  /** A-8: edit a journey order before it ships. Lines only while CONFIRMED - once packed they are locked to the shelf (contract §2). */
  @Permissions('orders', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.edits.update(user, requireTenantId(user), id, dto);
  }

  /** A-8: hand the order to another person in charge without opening the edit form. */
  @Permissions('orders', 'update')
  @Patch(':id/assignee')
  setAssignee(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderAssigneeDto,
  ) {
    return this.edits.setAssignee(user, requireTenantId(user), id, dto);
  }

  /** A-8: re-tag the order's priority from the list. */
  @Permissions('orders', 'update')
  @Patch(':id/priority')
  setPriority(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderPriorityDto,
  ) {
    return this.edits.setPriority(user, requireTenantId(user), id, dto);
  }

  /** A-4: make a line to the customer's measure. The first time it gets a ProductItem of its own; only while CONFIRMED, and fixed once a production request for it is sent. */
  @Permissions('orders', 'update')
  @Put(':id/items/:itemId/customization')
  customize(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: OrderItemCustomizationDto,
  ) {
    return this.customizations.customize(
      user,
      requireTenantId(user),
      id,
      itemId,
      dto,
    );
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

  /**
   * Đóng đơn (C-1): CONFIRMED → PACKED, khoá hàng, chặn nếu trên kệ thiếu. **Cố ý không có
   * `@Permissions`**: người phụ trách đơn đóng được đơn của mình mà không cần quyền trong role (chốt
   * 2026-10-06), nên quyền được kiểm trong service – chủ shop, người phụ trách, hoặc `orders:pack` tại
   * kho xuất (`assertOrderStepAccess`). `pack` vẫn là quyền riêng: người đóng gói không sửa được đơn.
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pack')
  pack(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PackOrderDto,
  ) {
    return this.fulfillments.packOrder(user, id, dto);
  }

  /**
   * C-2: PICKED_UP → SHIPPING, bước trừ tồn kho (trừ đúng phần đã khoá lúc đóng gói). **Cố ý không có
   * `@Permissions`**, cùng lý do với `pack`: chủ shop, người phụ trách, hoặc `orders:ship` tại kho của
   * fulfillment – kiểm trong `ShipmentService.shipOrder`.
   */
  @HttpCode(HttpStatus.OK)
  @Post(':id/ship')
  ship(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipOrderDto,
  ) {
    return this.shipments.shipOrder(user, requireTenantId(user), id, dto);
  }

  /** A-5: cancel a journey order before its goods leave stock (CONFIRMED / PACKED / PICKED_UP). A packed order's lock goes back to the shelf; a deposit is refunded by the amount the caller names. */
  @Permissions('orders', 'update')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.cancels.cancel(user, requireTenantId(user), id, dto);
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
    private readonly delivery: ShipmentDeliveryService,
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

      const transferAmount = Number(payload.transferAmount ?? 0);

      // 1. Bán tại quầy: mã nằm trên đơn (`Order.paymentReference`).
      const order = await this.service.completeSepayOrder(
        tenant.id,
        reference,
        transactionId,
        transferAmount,
      );
      if (order) {
        return { success: true, message: 'Order payment confirmed' };
      }

      // 2. Thu tiền QR lúc giao (C-5): mã nằm trên khoản thanh toán (`Payment.paymentReference`).
      const handled = await this.delivery.settleSepayBalance(
        tenant.id,
        reference,
        transactionId,
        transferAmount,
      );
      return handled
        ? { success: true, message: 'Delivery payment processed' }
        : { success: false, message: 'Order not found or already processed' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
