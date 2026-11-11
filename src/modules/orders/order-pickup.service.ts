import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { InvoiceService } from '../invoices/invoices.service';
import { OrderService } from './orders.service';
import { assertOrderStepAccess, OrderStepPermission } from './order-handler';
import { PickupCollectDto } from './dto/pickup-collect.dto';
import { PickupHandOverDto } from './dto/pickup-hand-over.dto';
import {
  assertPickupReady,
  assertStorePickup,
  openCounterQr,
  pickupAmountDue,
} from './order-pickup.rules';
import { assigneeClaim } from './order-handler';
import { writePaymentCashFlow } from './order-cash-flow';
import { cancelCounterQr, cancelData } from './payment-cancel';
import { CashFlowCategory } from '../../common/constants/cash-flow-category';
import { lockOrder } from './order-lock';
import { syncOrderPaymentStatus } from './payment-status';
import { completedData } from './order-status';
import { postSale } from './sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { toDong } from '../../common/utils/money';
import { requireTenantBanking } from './tenant-banking';
import { isQrExpired, newQrExpiresAt, sepayQrView } from './sepay-qr';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import {
  InventoryRefType,
  InventoryTxType,
} from '../../common/constants/inventory-ledger';
import {
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  DeliveryCollectionMethod,
  OPEN_QR_PAYMENT_STATUSES,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';
import { OrderEventType } from '../../common/constants/order-event-type';
import { recordOrderEvent, userActor } from './order-events';

// `cancelData` / `cancelCounterQr` nằm trong `payment-cancel.ts` (đơn quầy cũng dùng, mà `orders.service.ts` không import được file này vì vòng phụ thuộc); xuất lại ở đây cho các nơi đã import từ đây.
export { cancelData, cancelCounterQr } from './payment-cancel';

/**
 * Đơn khách tới lấy (STORE_PICKUP): đóng gói xong thì đơn nằm ở PACKED chờ khách, không có shipment.
 * - `collect`: thu số còn lại tại quầy (tiền mặt ghi luôn, QR chờ webhook SePay).
 * - `handOver`: đã thu đủ thì giao hàng cho khách: trừ tồn, PACKED → COMPLETED, xuất hoá đơn.
 * Bước thu tiền và giao dùng chung quyền với “Bắt đầu vận chuyển” (`OrderStepPermission.SHIP`): chủ shop, người có `orders:ship` tại kho xuất.
 */
@Injectable()
export class OrderPickupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly invoices: InvoiceService,
  ) {}

  /** Nạp đơn cùng fulfillment đã đóng gói; chặn đơn không phải khách tới lấy, chưa sẵn sàng, hay người gọi không có quyền. */
  private async loadPickupOrder(user: AuthUser, tenantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        code: true,
        status: true,
        fulfillmentType: true,
        assigneeId: true,
        branchId: true,
        grandTotal: true,
        updatedAt: true,
        note: true,
        payments: {
          select: {
            id: true,
            kind: true,
            method: true,
            status: true,
            amount: true,
            paymentReference: true,
            expiresAt: true,
            createdAt: true,
          },
        },
        fulfillments: {
          where: { status: FulfillmentStatus.PACKED },
          select: {
            id: true,
            locationId: true,
            items: {
              select: {
                quantity: true,
                orderItemId: true,
                orderItem: {
                  select: { productItemId: true, sku: true, productName: true },
                },
              },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    assertStorePickup(order);
    assertPickupReady(order);
    const [fulfillment] = order.fulfillments;
    const access = assertOrderStepAccess(
      user,
      order,
      OrderStepPermission.SHIP,
      fulfillment?.locationId ?? order.branchId,
    );
    return { order, fulfillment, access };
  }

  /**
   * Thu số còn lại của đơn đang chờ khách. Số tiền do server tính (tổng đơn trừ mọi khoản đã thu), không nhận từ client.
   * Tiền mặt ghi luôn là đã thu tại quầy (không có bước nộp lại như shipper); QR dựng khoản SEPAY chờ webhook và trả `qrUrl`.
   * Gọi lại với QR khi khoản chờ còn đúng số tiền VÀ còn hạn thì dùng lại khoản đó, để mã QR khách đang quét không đổi. Hết hạn thì huỷ khoản cũ và phát mã mới (không bao giờ trả mã đã hết hạn).
   */
  async collect(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: PickupCollectDto,
  ) {
    const { order, fulfillment, access } = await this.loadPickupOrder(
      user,
      tenantId,
      id,
    );
    // Tiền mặt thu tại quầy vào két của nơi xuất hàng (kho đóng gói), không phải chi nhánh bán đơn (quyết định 2026-11-11).
    const cashLocationId = fulfillment?.locationId ?? order.branchId;
    const amountDue = pickupAmountDue(order.grandTotal, order.payments);
    if (amountDue === 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
        message: 'Nothing is left to collect on this order',
      });
    }

    const pending = openCounterQr(order.payments);
    const now = new Date();

    if (dto.method === DeliveryCollectionMethod.CASH) {
      await this.prisma.$transaction(async (tx) => {
        // Khoá đơn trước, rồi đọc lại các khoản: hai lần bấm "thu tiền mặt" cùng lúc xếp hàng ở đây, lần sau thấy đã đủ tiền.
        await this.lockPickupOrder(tx, tenantId, id);
        const fresh = await tx.payment.findMany({
          where: { orderId: id, tenantId },
          select: {
            id: true,
            kind: true,
            method: true,
            status: true,
            amount: true,
          },
        });
        if (pickupAmountDue(order.grandTotal, fresh) !== amountDue) {
          throw new BadRequestException({
            code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
            message: 'Nothing is left to collect on this order',
          });
        }
        // Khách trả tiền mặt thay vì quét QR: huỷ khoản QR đang chờ, nếu tiền vừa về thì dừng.
        await cancelCounterQr(tx, openCounterQr(fresh), user.userId, now);
        // Lệnh chiếm: còn chờ khách, chưa đủ tiền, và không ai đổi đơn kể từ lúc đọc. `updatedAt` ghi tường minh để câu UPDATE là một lệnh chiếm thật (data rỗng không làm nhảy @updatedAt).
        const claimed = await tx.order.updateMany({
          where: {
            id,
            tenantId,
            status: OrderStatus.PACKED,
            paymentStatus: { not: OrderPaymentStatus.PAID },
            updatedAt: order.updatedAt,
            ...assigneeClaim(access, user),
          },
          data: { updatedAt: now },
        });
        if (claimed.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The order has just changed, please reload',
          });
        }
        const payment = await tx.payment.create({
          data: {
            tenantId,
            orderId: id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.CASH,
            amount: amountDue,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: cashLocationId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
          select: { id: true, amount: true, method: true },
        });
        await writePaymentCashFlow(tx, {
          tenantId,
          payment,
          category: CashFlowCategory.ORDER_PAYMENT,
          orderId: id,
          orderCode: order.code,
          locationId: cashLocationId,
          createdById: user.userId,
          description: `Thu tiền tại quầy đơn ${order.code}`,
        });
        await syncOrderPaymentStatus(tx, id);
        // QR không ghi ở đây: khoản chờ chưa phải tiền về, sự kiện QR_PAID đến cùng webhook.
        await recordOrderEvent(tx, userActor(user), {
          tenantId,
          orderId: id,
          type: OrderEventType.PICKUP_COLLECTED,
          metadata: {
            amount: amountDue,
            method: PaymentMethod.CASH,
            paymentId: payment.id,
          },
        });
      });
      return {
        order: await this.orders.findOne(user, tenantId, id),
        payment: null,
      };
    }

    const banking = await requireTenantBanking(this.prisma, tenantId);
    const reusable = pending.find(
      (p) =>
        p.status === PaymentRecordStatus.PENDING &&
        toDong(p.amount) === amountDue &&
        !isQrExpired(p, now),
    );
    let reference = reusable?.paymentReference ?? null;
    let expiresAt = reusable?.expiresAt ?? null;
    let createdAt = reusable?.createdAt ?? now;
    if (!reusable) {
      reference = generateReference(REFERENCE_PREFIX.ORDER);
      expiresAt = newQrExpiresAt(now);
      createdAt = now;
      await this.prisma.$transaction(async (tx) => {
        // Huỷ cả khoản đã hết hạn lẫn khoản sai số tiền; số khoản huỷ được phải khớp số khoản đọc ra, nếu không có khoản vừa đổi trạng thái (tiền vừa về) thì dừng.
        await this.lockPickupOrder(tx, tenantId, id);
        const cancelled = await tx.payment.updateMany({
          where: {
            id: { in: pending.map((p) => p.id) },
            status: { in: [...OPEN_QR_PAYMENT_STATUSES] },
          },
          data: cancelData(user.userId, now),
        });
        if (cancelled.count !== pending.length) {
          throw new ConflictException({
            code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
            message: 'The transfer has just arrived, please reload',
          });
        }
        await tx.payment.create({
          data: {
            tenantId,
            orderId: id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.SEPAY,
            amount: amountDue,
            requestedAmount: amountDue,
            status: PaymentRecordStatus.PENDING,
            paymentReference: reference,
            expiresAt,
            locationId: order.branchId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      });
    }
    // Mã chỉ phát qua sepayQrView (cửa duy nhất tới link VietQR); vừa tạo hay dùng lại đều đã kiểm còn hạn.
    const view = sepayQrView(
      banking,
      { amount: amountDue, reference: reference!, expiresAt, createdAt },
      'issue',
      now,
    );
    return {
      order: await this.orders.findOne(user, tenantId, id),
      payment: {
        reference: reference!,
        amount: amountDue,
        status: PaymentRecordStatus.PENDING,
        qrUrl: view.qrUrl!,
        expiresAt: view.expiresAt.toISOString(),
      },
    };
  }

  /** Khoá đơn đầu transaction; không thấy đơn trong shop thì 404. */
  private async lockPickupOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ) {
    if (!(await lockOrder(tx, tenantId, id))) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
  }

  /**
   * Giao hàng cho khách tại quầy, khi đã thu đủ. Một transaction: đơn PACKED → COMPLETED, hàng khoá rời kho (rút theo lô,
   * ghi sổ SALE kèm dòng đơn nên hoàn hàng sau này tra được), dòng đơn SHIPPED, fulfillment HANDED_OVER, hoá đơn phát hành.
   * Còn tiền chưa thu thì từ chối (`ORDER_PICKUP_BALANCE_DUE`); khoản QR đang chờ chưa tính là đã thu.
   */
  async handOver(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: PickupHandOverDto,
  ) {
    const { order, fulfillment, access } = await this.loadPickupOrder(
      user,
      tenantId,
      id,
    );
    if (!fulfillment) {
      throw new ConflictException({
        code: ErrorCode.ORDER_PICKUP_NOT_READY,
        message: 'The order has no packed fulfillment to hand over',
      });
    }
    const amountDue = pickupAmountDue(order.grandTotal, order.payments);
    if (amountDue > 0) {
      throw new ConflictException({
        code: ErrorCode.ORDER_PICKUP_BALANCE_DUE,
        message: `${amountDue} is still due; collect it before handing the goods over`,
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Khoá đơn rồi đọc lại tiền: một khoản vừa bị huỷ hay hoàn thì không giao hàng trên số tiền cũ.
      await this.lockPickupOrder(tx, tenantId, id);
      const fresh = await tx.payment.findMany({
        where: { orderId: id, tenantId },
        select: { kind: true, status: true, amount: true },
      });
      const dueNow = pickupAmountDue(order.grandTotal, fresh);
      if (dueNow > 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PICKUP_BALANCE_DUE,
          message: `${dueNow} is still due; collect it before handing the goods over`,
        });
      }
      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: OrderStatus.PACKED,
          ...assigneeClaim(access, user),
        },
        data: {
          ...completedData(now),
          shippedById: user.userId,
          shippedAt: now,
          ...(dto.receiverName || dto.note
            ? { note: appendHandOverNote(order.note, dto) }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }

      // Một UPDATE có điều kiện cho mỗi dòng (locked_stock ≥ quantity) là chốt chặn, nên không gom được thành một query.
      for (const item of fulfillment.items) {
        await this.inventory.shipLockedStock(tx, {
          tenantId,
          locationId: fulfillment.locationId,
          productItemId: item.orderItem.productItemId,
          quantity: item.quantity,
          label:
            item.orderItem.sku ??
            item.orderItem.productName ??
            item.orderItemId,
          ledger: {
            type: InventoryTxType.SALE,
            referenceType: InventoryRefType.ORDER,
            referenceId: id,
            orderItemId: item.orderItemId,
            createdById: user.userId,
          },
        });
      }
      await tx.orderItem.updateMany({
        where: {
          id: { in: fulfillment.items.map((item) => item.orderItemId) },
          status: OrderItemStatus.PENDING,
        },
        data: { status: OrderItemStatus.SHIPPED },
      });
      const handed = await tx.fulfillment.updateMany({
        where: { id: fulfillment.id, status: FulfillmentStatus.PACKED },
        data: { status: FulfillmentStatus.HANDED_OVER, handedOverAt: now },
      });
      if (handed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The fulfillment has just changed, please reload',
        });
      }
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: id,
        type: OrderEventType.PICKUP_HANDED_OVER,
        fromStatus: OrderStatus.PACKED,
        toStatus: OrderStatus.COMPLETED,
        metadata: {
          receiverName: dto.receiverName ?? null,
          note: dto.note ?? null,
        },
      });
      // Hàng vừa rời kho (shipLockedStock ở trên ghi sổ lô): giờ mới đọc được giá vốn.
      await postSale(tx, {
        orderId: id,
        actor: { id: user.userId },
        now,
        source: SalesJournalSource.PICKUP_HAND_OVER,
      });
      await this.invoices.issueForOrder(tx, id, user.userId);
    });

    return { order: await this.orders.findOne(user, tenantId, id) };
  }
}

/** Ghi người nhận và ghi chú giao hàng vào ghi chú của đơn, để người xem sau còn biết ai đã nhận hàng. */
function appendHandOverNote(
  current: string | null,
  dto: PickupHandOverDto,
): string {
  const parts = [
    dto.receiverName ? `Người nhận: ${dto.receiverName}` : null,
    dto.note ?? null,
  ].filter(Boolean);
  const line = `[Giao tại quầy] ${parts.join(' - ')}`;
  return current
    ? `${current}
${line}`
    : line;
}
