import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceService } from '../invoices/invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { OrderService } from './orders.service';
import { canTransition } from './order-status';
import { CancelOrderDto } from './dto/cancel-order.dto';
import {
  FulfillmentType,
  OrderItemStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import { recordRefundPayment, resolveRefund } from './order-refund';
import { lockOrder } from './order-lock';
import { postOtherIncome } from './sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { syncOrderPaymentStatus } from './payment-status';
import { openCounterQr } from './order-pickup.rules';
import { cancelCounterQr } from './order-pickup.service';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import {
  FINAL_SHIPMENT_STATUSES,
  ShipmentStatus,
} from '../../common/constants/shipment-status';
import { OPEN_PRODUCTION_REQUEST_STATUSES } from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import { OrderEventType } from '../../common/constants/order-event-type';
import { recordOrderEvent, userActor } from './order-events';

const LOCKING_FULFILLMENT_STATUSES: readonly string[] = [
  FulfillmentStatus.PACKED,
  FulfillmentStatus.HANDED_OVER,
];

// Xuất lại các hàm hoàn tiền từ `order-refund.ts`.
export {
  depositHeld,
  resolveRefund,
  type DepositPaymentRow,
  type ResolvedRefund,
} from './order-refund';

/** Huỷ đơn hành trình khi hàng chưa rời kho; trả hàng khoá về kệ, huỷ chuyến giao. */
@Injectable()
export class OrderCancelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly invoices: InvoiceService,
  ) {}

  async cancel(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: CancelOrderDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          select: {
            id: true,
            status: true,
            productItemId: true,
            sku: true,
            productName: true,
          },
        },
        payments: true,
        fulfillments: {
          where: { status: { in: [...LOCKING_FULFILLMENT_STATUSES] } },
          include: { items: true },
        },
      },
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }

    // Đơn bán tại quầy hủy qua PATCH /orders/:id/status, route đó mới hoàn lại tồn kho và dòng tiền.
    if (
      order.fulfillmentType === FulfillmentType.TAKEAWAY ||
      !canTransition(order.status, OrderStatus.CANCELLED)
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_CANCEL_NOT_ALLOWED,
        message:
          order.fulfillmentType === FulfillmentType.TAKEAWAY
            ? 'A counter sale is cancelled from the till'
            : `An order in ${order.status} cannot be cancelled - its goods have left; use a return`,
      });
    }

    const labels = new Map(
      order.items.map((item) => [
        item.id,
        {
          productItemId: item.productItemId,
          label: item.sku ?? item.productName ?? item.id,
        },
      ]),
    );
    const now = new Date();

    const refund = await this.prisma.$transaction(async (tx) => {
      let refundPaymentId: string | undefined;
      // Khoá đơn rồi mới đọc lại các khoản và tính hoàn tiền.
      if (!(await lockOrder(tx, tenantId, id))) {
        throw new NotFoundException({
          code: ErrorCode.ORDER_NOT_FOUND,
          message: 'Order not found',
        });
      }
      const payments = await tx.payment.findMany({ where: { orderId: id } });
      const refund = resolveRefund(
        payments.map((p) => ({ ...p, amount: Number(p.amount) })),
        dto.refundAmount,
        dto.refundMethod,
      );
      // Chiếm đơn theo trạng thái vừa đọc để tránh chạy đua.
      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: order.status,
          updatedAt: order.updatedAt,
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledById: user.userId,
          cancelledAt: now,
          cancelReason: dto.reason || null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }

      // Huỷ mã QR thu tại quầy; tiền vừa về thì dừng.
      await cancelCounterQr(tx, openCounterQr(payments), user.userId, now);

      // Đơn hủy được chưa bao giờ COMPLETED nên hóa đơn chưa phát hành: chỉ cần thu hồi.
      await this.invoices.voidPending(tx, id);

      for (const fulfillment of order.fulfillments) {
        for (const item of fulfillment.items) {
          const line = labels.get(item.orderItemId)!;
          await this.inventory.releaseLockedStock(tx, {
            tenantId,
            locationId: fulfillment.locationId,
            productItemId: line.productItemId,
            quantity: item.quantity,
            label: line.label,
          });
        }
      }
      if (order.fulfillments.length > 0) {
        await tx.fulfillment.updateMany({
          where: { id: { in: order.fulfillments.map((f) => f.id) } },
          data: { status: FulfillmentStatus.CANCELLED },
        });
      }
      await tx.shipment.updateMany({
        where: {
          orderId: id,
          status: { notIn: [...FINAL_SHIPMENT_STATUSES] },
        },
        data: { status: ShipmentStatus.CANCELLED },
      });
      await tx.orderItem.updateMany({
        where: { orderId: id, status: OrderItemStatus.PENDING },
        data: { status: OrderItemStatus.CANCELLED },
      });

      if (refund && refund.amount > 0) {
        // Ghi khoản REFUND và dòng chi tương ứng.
        const payment = await recordRefundPayment(tx, {
          order,
          amount: refund.amount,
          method: refund.method,
          refundOfPaymentId: refund.refundOfPaymentId,
          actorId: user.userId,
          note: dto.reason || null,
          description: `Hoàn tiền huỷ đơn ${order.code}`,
          now,
        });
        refundPaymentId = payment.id;
      }
      // Cập nhật trạng thái thanh toán theo các khoản.
      const afterCancel = await syncOrderPaymentStatus(tx, id);
      // Tiền shop giữ lại sau khi hoàn ghi là thu nhập khác.
      await postOtherIncome(tx, {
        orderId: id,
        kept: afterCancel.net,
        actor: { id: user.userId },
        now,
        source: SalesJournalSource.ORDER_CANCEL,
      });
      // Ghi sự kiện huỷ cuối transaction.
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: id,
        type: OrderEventType.CANCELLED,
        fromStatus: order.status,
        toStatus: OrderStatus.CANCELLED,
        metadata: {
          reason: dto.reason || null,
          refundAmount: refund?.amount ?? 0,
          refundMethod: refund && refund.amount > 0 ? refund.method : null,
          paymentId: refundPaymentId,
        },
      });
      return refund;
    });

    const openProductionRequests =
      await this.prisma.productionRequestItem.findMany({
        where: {
          orderItem: { orderId: id },
          productionRequest: {
            status: { in: [...OPEN_PRODUCTION_REQUEST_STATUSES] },
          },
        },
        select: {
          id: true,
          quantity: true,
          receivedQuantity: true,
          orderItemId: true,
          productionRequest: {
            select: { id: true, code: true, status: true },
          },
        },
      });

    return {
      order: await this.orders.findOne(user, tenantId, id),
      refund: refund
        ? {
            held: refund.held,
            refunded: refund.amount,
            kept: refund.held - refund.amount,
          }
        : null,
      openProductionRequests,
    };
  }
}
