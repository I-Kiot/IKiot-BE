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

// Xuất lại các hàm huỷ khoản từ `payment-cancel.ts`.
export { cancelData, cancelCounterQr } from './payment-cancel';

/** Đơn khách tới lấy: thu số còn lại tại quầy và giao hàng cho khách. */
@Injectable()
export class OrderPickupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly invoices: InvoiceService,
  ) {}

  /** Nạp đơn đã đóng gói và kiểm có giao cho khách được không. */
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

  /** Thu số còn lại của đơn chờ khách: tiền mặt ghi luôn, QR chờ webhook. */
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
    // Tiền mặt vào két của nơi xuất hàng.
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
        // Khoá đơn rồi đọc lại các khoản.
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
        // Chiếm đơn: còn chờ khách, chưa đủ tiền, chưa ai đổi.
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
        // Huỷ các khoản QR cũ; số huỷ được phải khớp số đã đọc.
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
    // Lấy link QR qua `sepayQrView`.
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

  /** Giao hàng cho khách tại quầy khi đã thu đủ: trừ tồn, hoàn tất đơn, xuất hoá đơn. */
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

      // Trừ hàng khoá từng dòng có điều kiện.
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
