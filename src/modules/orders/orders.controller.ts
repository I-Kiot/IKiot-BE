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
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { OrderImportService } from './import/order-import.service';
import { MAX_ORDER_IMPORT_BYTES } from './import/order-import.columns';
import { XLSX_MIME } from '../products/import/product-import.service';
import { OrderService } from './orders.service';
import { SepayOrderService } from './sepay-order.service';
import { sepayTransferFromPayload } from './sepay-qr';
import { SepayRejectReason } from '../../common/constants/payment-method';
import { ManualOrderService } from './manual-order.service';
import { OrderCancelService } from './order-cancel.service';
import { OrderExcessRefundService } from './order-excess-refund.service';
import { RefundExcessDto } from './dto/refund-excess.dto';
import { OrderHeldSettleService } from './order-held-settle.service';
import { SettleHeldDto } from './dto/settle-held.dto';
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
  CancelPosSaleDto,
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
import { OrderPickupService } from './order-pickup.service';
import { PickupCollectDto } from './dto/pickup-collect.dto';
import { PickupHandOverDto } from './dto/pickup-hand-over.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ChangeFeedService } from '../../common/realtime/change-feed.service';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';
import { EmitsChange } from '../../common/realtime/emits-change.decorator';
import { OrderChanges } from './orders.change-template';

/** Controller đơn hàng: quầy, hành trình đơn và webhook SePay. */
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
    private readonly excessRefunds: OrderExcessRefundService,
    private readonly heldSettle: OrderHeldSettleService,
    private readonly reads: OrderReadService,
    private readonly edits: OrderEditService,
    private readonly customizations: OrderCustomizationService,
    private readonly remittances: OrderRemittanceService,
    private readonly pickups: OrderPickupService,
    private readonly importer: OrderImportService,
  ) {}

  /** File mẫu nhập đơn: dropdown chi nhánh, nhân viên lấy từ dữ liệu cửa hàng. Khai báo trên `:id`. */
  @Permissions('orders', 'create')
  @Get('import/template')
  @ApiProduces(XLSX_MIME)
  async importTemplate(@CurrentUser() user: AuthUser) {
    const buffer = await this.importer.buildTemplate(
      user,
      requireTenantId(user),
    );
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: 'attachment; filename="mau-nhap-don-hang.xlsx"',
    });
  }

  /** Nhập đơn tay từ file mẫu: cả file đúng mới tạo, mỗi đơn qua đúng bước kiểm của `POST /orders`. */
  @Permissions('orders', 'create')
  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @EmitsChange(OrderChanges.imported)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_ORDER_IMPORT_BYTES + 1 },
    }),
  )
  importOrders(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.importer.import(user, requireTenantId(user), file);
  }

  /** Đơn tay (A-2): sinh ra ở CONFIRMED, có người phụ trách (contract §2). */
  @Permissions('orders', 'create')
  @Post()
  @EmitsChange(OrderChanges.created)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.manualOrders.create(user, requireTenantId(user), dto);
  }

  /** Bán tại quầy: thu và trừ kho ngay, nằm ngoài hành trình. Trước A-2 route này là `POST /orders`. */
  @Permissions('orders', 'create')
  @Post('pos')
  @EmitsChange(OrderChanges.posCreated)
  createPosSale(@CurrentUser() user: AuthUser, @Body() dto: CreatePosOrderDto) {
    return this.service.createPosSale(user, requireTenantId(user), dto);
  }

  /** Huỷ đơn quầy đang chờ QR; người chỉ có `orders:create` chỉ huỷ được đơn của mình. */
  @Permissions('orders', 'create', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('pos/:id/cancel')
  @EmitsChange(OrderChanges.cancelled)
  cancelPosSale(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPosSaleDto,
  ) {
    return this.service.cancelPosSale(user, requireTenantId(user), id, dto);
  }

  /** Phát mã QR cho phần còn lại của đơn quầy chờ SePay. */
  @Permissions('orders', 'create', 'update')
  @HttpCode(HttpStatus.OK)
  @Post('pos/:id/qr')
  createPosQr(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.createPosQr(user, requireTenantId(user), id);
  }

  /** Danh sách hành trình (A-9), là tập cha của những gì POS đang đọc từ route này. */
  @Permissions('orders', 'read')
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: QueryOrderJourneyDto) {
    return this.reads.findAll(user, requireTenantId(user), query);
  }

  /** Số đơn cần chú ý. */
  @Permissions('orders', 'read')
  @Get('alerts')
  alerts(
    @CurrentUser() user: AuthUser,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.reads.alerts(user, requireTenantId(user), branchId);
  }

  /** Chi nhánh và kho mà đơn lấy hàng được, cho ô "Nguồn hàng" khi tạo / sửa đơn. Khai báo trên `:id`. */
  @Permissions('orders', 'create', 'update')
  @Get('source-locations')
  sourceLocations(@CurrentUser() user: AuthUser) {
    return this.manualOrders.listSourceLocations(requireTenantId(user));
  }

  @Permissions('orders', 'read')
  @Get(':id')
  findOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reads.findOne(user, requireTenantId(user), id);
  }

  /** Nhật ký thao tác của đơn. */
  @Permissions('orders', 'read')
  @Get(':id/events')
  events(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reads.events(user, requireTenantId(user), id);
  }

  /** Sửa đơn hành trình trước khi giao. */
  @Permissions('orders', 'update')
  @Patch(':id')
  @EmitsChange(OrderChanges.edited)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.edits.update(user, requireTenantId(user), id, dto);
  }

  /** Người có thể phụ trách đơn; quyền kiểm trong service. */
  @Get(':id/assignees')
  listAssignees(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.edits.listAssignees(user, requireTenantId(user), id);
  }

  /** Đổi người phụ trách; quyền kiểm trong service. */
  @Patch(':id/assignee')
  @EmitsChange(OrderChanges.assigneeChanged)
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
  @EmitsChange(OrderChanges.priorityChanged)
  setPriority(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderPriorityDto,
  ) {
    return this.edits.setPriority(user, requireTenantId(user), id, dto);
  }

  /** Lưu thông số may đo cho dòng đơn. */
  @Permissions('orders', 'update')
  @Put(':id/items/:itemId/customization')
  @EmitsChange(OrderChanges.customized)
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

  /** Chủ shop xác nhận shipper đã nộp đủ tiền. */
  @Permissions('orders', 'confirm_cash')
  @HttpCode(HttpStatus.OK)
  @Post(':id/confirm-remittance')
  @EmitsChange(OrderChanges.remittanceConfirmed)
  confirmRemittance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmRemittanceDto,
  ) {
    return this.remittances.confirm(user, requireTenantId(user), id, dto);
  }

  @Permissions('orders', 'update')
  @Patch(':id/status')
  @EmitsChange(OrderChanges.statusChanged)
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

  /** Đóng gói đơn: CONFIRMED → PACKED; quyền kiểm trong service. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pack')
  @EmitsChange(OrderChanges.packed)
  pack(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PackOrderDto,
  ) {
    return this.fulfillments.packOrder(user, id, dto);
  }

  /** Bắt đầu vận chuyển: PICKED_UP → SHIPPING, trừ tồn; quyền kiểm trong service. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/ship')
  @EmitsChange(OrderChanges.shipped)
  ship(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ShipOrderDto,
  ) {
    return this.shipments.shipOrder(user, requireTenantId(user), id, dto);
  }

  /** Thu số còn lại tại quầy của đơn khách tới lấy. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pickup/collect')
  @EmitsChange(OrderChanges.pickupCollected)
  pickupCollect(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PickupCollectDto,
  ) {
    return this.pickups.collect(user, requireTenantId(user), id, dto);
  }

  /** Giao hàng cho khách tới lấy đã thu đủ. */
  @HttpCode(HttpStatus.OK)
  @Post(':id/pickup/hand-over')
  @EmitsChange(OrderChanges.pickupHandedOver)
  pickupHandOver(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PickupHandOverDto,
  ) {
    return this.pickups.handOver(user, requireTenantId(user), id, dto);
  }

  /** Huỷ đơn hành trình trước khi hàng rời kho. */
  @Permissions('orders', 'update')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  @EmitsChange(OrderChanges.cancelled)
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.cancels.cancel(user, requireTenantId(user), id, dto);
  }

  /** Quyết định tiền treo của đơn đã kết thúc. */
  @Permissions('returns', 'inspect')
  @HttpCode(HttpStatus.OK)
  @Post(':id/settle-held')
  @EmitsChange(OrderChanges.heldSettled)
  settleHeld(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettleHeldDto,
  ) {
    return this.heldSettle.settle(user, requireTenantId(user), id, dto);
  }

  /** Hoàn phần khách chuyển dư. */
  @Permissions('returns', 'inspect')
  @HttpCode(HttpStatus.OK)
  @Post(':id/refund-excess')
  @EmitsChange(OrderChanges.excessRefunded)
  refundExcess(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundExcessDto,
  ) {
    return this.excessRefunds.refundExcess(
      user,
      requireTenantId(user),
      id,
      dto,
    );
  }

  /** Chốt đơn SePay đã trả bằng cách khác. */
  @Permissions('orders', 'update', 'pay_offline')
  @HttpCode(HttpStatus.OK)
  @Post(':id/pay-offline')
  @EmitsChange(OrderChanges.paidOffline)
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

/** Webhook SePay, luôn trả 200. */
@ApiTags('orders')
@Controller('webhook/sepay')
export class SepayOrderWebhookController {
  constructor(
    private readonly service: OrderService,
    private readonly sepay: SepayOrderService,
    private readonly delivery: ShipmentDeliveryService,
    private readonly changeFeed: ChangeFeedService,
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
      // Chuẩn hoá giao dịch kèm khoá chống lặp.
      const transfer = sepayTransferFromPayload(payload);
      const content =
        typeof payload.content === 'string' ? payload.content : '';
      const reference = this.sepay.extractOrderReference(content);

      const tenant = await this.sepay.resolveTenant(apiKey, payload);
      if (!tenant) {
        // Chỉ ghi sổ "không thuộc shop nào" khi webhook dùng key dùng chung.
        if (this.sepay.isSharedKey(apiKey) && transfer.amount > 0) {
          const recorded = await this.sepay.recordUnmatched(
            null,
            transfer,
            reference,
            SepayRejectReason.UNKNOWN_TENANT,
          );
          return { success: true, message: recorded.message };
        }
        return { success: false, message: 'Unknown API key or account' };
      }
      // Không có tiền (số 0 / không phải số) thì không có gì để ghi sổ.
      if (!(transfer.amount > 0)) {
        return { success: true, message: 'No amount to record' };
      }

      if (!reference) {
        const recorded = await this.sepay.recordUnmatched(
          tenant.id,
          transfer,
          null,
          SepayRejectReason.NO_REFERENCE,
        );
        return { success: true, message: recorded.message };
      }

      // 1. Bán tại quầy: mã nằm trên khoản thanh toán của đơn quầy.
      const order = await this.service.completeSepayTransfer(
        tenant.id,
        reference,
        transfer,
      );
      // Đã ghi sổ nên trả success để SePay thôi gọi lại.
      if (order) {
        return { success: true, message: order.message };
      }

      // Thu tiền QR lúc giao / tại quầy.
      const outcome = await this.delivery.settleSepayTransfer(
        tenant.id,
        reference,
        transfer,
      );
      if (outcome.kind === 'HANDLED') {
        // Trùng / bị từ chối thì không có dữ liệu nào đổi, nên không phát gì.
        if (outcome.settled) {
          this.changeFeed.publish({
            tenantId: tenant.id,
            spec: outcome.settled.partial
              ? OrderChanges.qrPartiallyPaid
              : OrderChanges.qrPaid,
            target: {
              subjectId: outcome.settled.order.id,
              code: outcome.settled.order.code,
              related: { shipments: [] },
            },
            actor: { source: 'WEBHOOK' },
          });
        }
        return { success: true, message: 'Delivery payment processed' };
      }

      // 3. Có mã ORD nhưng không khoản nào của shop mang mã đó: vẫn là tiền thật đã về, ghi sổ để đối soát.
      const recorded = await this.sepay.recordUnmatched(
        tenant.id,
        transfer,
        reference,
        SepayRejectReason.UNKNOWN_REFERENCE,
      );
      return { success: true, message: recorded.message };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
