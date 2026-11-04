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
import { OrderRemittanceService } from './order-remittance.service';
import { ConfirmRemittanceDto } from './dto/confirm-remittance.dto';
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

/** Bản port của OrderController, cộng các route hành trình và webhook SePay. Không có DELETE: đơn không nên có thì chuyển sang CANCELLED hoặc RETURNED, cả hai đều để lại dấu vết. */
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
    private readonly remittances: OrderRemittanceService,
  ) {}

  /** Đơn tay (A-2): sinh ra ở CONFIRMED, có người phụ trách (contract §2). */
  @Permissions('orders', 'create')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.manualOrders.create(user, requireTenantId(user), dto);
  }

  /** Bán tại quầy: thu và trừ kho ngay, nằm ngoài hành trình. Trước A-2 route này là `POST /orders`. */
  @Permissions('orders', 'create')
  @Post('pos')
  createPosSale(@CurrentUser() user: AuthUser, @Body() dto: CreatePosOrderDto) {
    return this.service.createPosSale(user, requireTenantId(user), dto);
  }

  /** Danh sách hành trình (A-9), là tập cha của những gì POS đang đọc từ route này. */
  @Permissions('orders', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryOrderJourneyDto) {
    return this.reads.findAll(user, requireTenantId(user), query);
  }

  /** Số đơn cần chú ý (thiếu hàng trên kệ, sắp tới ngày giao). Khai báo trên `:id`, nếu không sẽ bị đọc thành mã đơn. */
  @Permissions('orders', 'read')
  @Get('alerts')
  alerts(
    @CurrentUser() user: AuthUser,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.reads.alerts(user, requireTenantId(user), branchId);
  }

  @Permissions('orders', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reads.findOne(user, requireTenantId(user), id);
  }

  /** Sửa đơn hành trình trước khi giao (A-8). Chỉ sửa dòng khi còn CONFIRMED; đã đóng gói thì hàng bị khóa trên kệ (contract §2). */
  @Permissions('orders', 'update')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.edits.update(user, requireTenantId(user), id, dto);
  }

  /** Đổi người phụ trách mà không cần mở form sửa (A-8). */
  @Permissions('orders', 'update')
  @Patch(':id/assignee')
  setAssignee(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderAssigneeDto,
  ) {
    return this.edits.setAssignee(user, requireTenantId(user), id, dto);
  }

  /** Đổi mức ưu tiên của đơn từ danh sách (A-8). */
  @Permissions('orders', 'update')
  @Patch(':id/priority')
  setPriority(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderPriorityDto,
  ) {
    return this.edits.setPriority(user, requireTenantId(user), id, dto);
  }

  /** Làm dòng thành đơn may theo số đo (A-4). Lần đầu dòng có ProductItem riêng; chỉ khi còn CONFIRMED, và bị khóa khi yêu cầu sản xuất của dòng đã gửi. */
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

  /** Chủ xác nhận shipper đã nộp đủ tiền thu khi giao (RECEIVED → COMPLETED). Có quyền riêng: đếm tiền không phải là sửa đơn. */
  @Permissions('orders', 'confirm_cash')
  @HttpCode(HttpStatus.OK)
  @Post(':id/confirm-remittance')
  confirmRemittance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmRemittanceDto,
  ) {
    return this.remittances.confirm(user, requireTenantId(user), id, dto);
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
   * Đóng đơn (C-1): CONFIRMED → PACKED, khoá hàng, chặn nếu trên kệ thiếu. **Cố ý không có `@Permissions`**: người phụ trách đóng được đơn của mình mà không cần quyền trong role (2026-10-06), nên quyền kiểm trong service (`assertOrderStepAccess`): chủ shop, người phụ trách, hoặc `orders:pack` tại kho xuất. `pack` vẫn là quyền riêng để người đóng gói không sửa được đơn.
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
   * C-2: PICKED_UP → SHIPPING, bước trừ tồn kho (đúng phần đã khoá lúc đóng gói). **Cố ý không có `@Permissions`**, cùng lý do với `pack`: chủ shop, người phụ trách, hoặc `orders:ship` tại kho của fulfillment, kiểm trong `ShipmentService.shipOrder`.
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

  /** Hủy đơn hành trình trước khi hàng rời kho (A-5): CONFIRMED / PACKED / PICKED_UP. Đơn đã đóng gói thì hàng khóa trả về kệ; cọc hoàn theo số tiền người gọi chỉ định. */
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

  /** Chốt đơn SePay đã trả bằng cách khác. Có một trong hai quyền là đủ, khớp với authorize orders update / pay_offline cũ, để role chỉ có `orders:update` không mất quyền khi port sang. */
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

/** Luôn trả 200 vì SePay retry mọi mã khác. Mã tham chiếu chỉ tra trong tenant đã xác định, nên tiền vào tài khoản shop B không chốt được đơn của shop A. */
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

      // SePay gửi "Apikey <key>", không phải "Bearer <key>".
      const apiKey = authHeader?.replace(/^Apikey\s+/i, '').trim() ?? '';
      const tenant = await this.sepay.resolveTenant(apiKey, payload);
      if (!tenant) {
        return { success: false, message: 'Unknown API key or account' };
      }

      const reference = this.sepay.extractOrderReference(
        typeof payload.content === 'string' ? payload.content : '',
      );
      if (!reference) {
        return { success: false, message: 'No order reference found' };
      }

      // SePay gửi mã giao dịch dạng số; request sai thì trả `null` chứ không phải `''`, vì chuỗi rỗng sẽ bị người đối soát hiểu là "đã có mã".
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
