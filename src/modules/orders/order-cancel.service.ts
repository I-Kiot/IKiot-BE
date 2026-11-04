import {
  BadRequestException,
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
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import {
  FINAL_SHIPMENT_STATUSES,
  ShipmentStatus,
} from '../../common/constants/shipment-status';
import { OPEN_PRODUCTION_REQUEST_STATUSES } from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';

const LOCKING_FULFILLMENT_STATUSES: readonly string[] = [
  FulfillmentStatus.PACKED,
  FulfillmentStatus.HANDED_OVER,
];

export interface DepositPaymentRow {
  id: string;
  kind: string;
  status: string;
  method: string;
  amount: number;
  createdAt: Date;
}

export interface ResolvedRefund {
  held: number;
  amount: number;
  method: string;
  refundOfPaymentId: string;
  paymentStatus: string;
}

/** Cọc shop còn giữ: tổng cọc PAID trừ tổng hoàn PAID. Quy tắc duy nhất: hoàn khi hủy (A-5) và kiểm tra khi sửa (A-8) đều đọc ở đây. */
export function depositHeld(
  payments: readonly Pick<DepositPaymentRow, 'kind' | 'status' | 'amount'>[],
): number {
  const paid = payments.filter((p) => p.status === PaymentRecordStatus.PAID);
  const sum = (kind: string) =>
    paid
      .filter((p) => p.kind === kind)
      .reduce((total, p) => total + p.amount, 0);
  return sum(PaymentKind.DEPOSIT) - sum(PaymentKind.REFUND);
}

/**
 * Hoàn cọc khi huỷ (A-5): người huỷ tự chọn số tiền hoàn, từ 0 (shop giữ cọc) tới toàn bộ số đang giữ. Không có mặc định vì mặc định nào cũng là chuyển tiền của khách mà chưa hỏi. Null khi không có gì để hoàn và không giữ gì.
 */
export function resolveRefund(
  payments: readonly DepositPaymentRow[],
  refundAmount: number | undefined,
  refundMethod: string | undefined,
): ResolvedRefund | null {
  const deposits = payments
    .filter(
      (p) =>
        p.status === PaymentRecordStatus.PAID && p.kind === PaymentKind.DEPOSIT,
    )
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const held = depositHeld(payments);

  if (held <= 0) {
    if (refundAmount) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
        message: 'This order holds no deposit to refund',
      });
    }
    return null;
  }
  if (refundAmount === undefined) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED,
      message: `The order holds a deposit of ${held}; say how much of it is refunded (0 keeps it)`,
    });
  }
  const amount = Math.round(refundAmount);
  if (amount > held) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT,
      message: `A refund of ${amount} exceeds the deposit held (${held})`,
    });
  }
  const [latest] = deposits;
  return {
    held,
    amount,
    method: refundMethod ?? latest.method,
    refundOfPaymentId: latest.id,
    paymentStatus:
      amount === 0
        ? OrderPaymentStatus.PARTIALLY_PAID
        : amount === held
          ? OrderPaymentStatus.REFUNDED
          : OrderPaymentStatus.PARTIALLY_REFUNDED,
  };
}

/**
 * `POST /orders/:id/cancel` (A-5): hủy đơn hành trình khi hàng chưa rời kho, tức CONFIRMED, PACKED hoặc PICKED_UP.
 * Đơn đã đóng gói thì hàng khóa trả về kệ (`releaseLockedStock`) và fulfillment thành CANCELLED; shipment đang mở cũng thành CANCELLED.
 * Từ SHIPPING trở đi hàng đã đi, chỉ hàng trả về mới đưa lại được. Yêu cầu sản xuất của các dòng không bị động tới
 * (xưởng có thể đang làm; hàng về sau thành tồn kho thường) và được liệt kê trong response để người xử lý quyết định.
 */
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

    const refund = resolveRefund(
      order.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
      dto.refundAmount,
      dto.refundMethod,
    );
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

    await this.prisma.$transaction(async (tx) => {
      // Chiếm đơn theo status vừa đọc: đóng gói hoặc bàn giao chạy đua với hủy thì một bên thắng trọn, bên kia bị từ chối.
      const claimed = await tx.order.updateMany({
        where: { id, tenantId, status: order.status },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledById: user.userId,
          cancelledAt: now,
          cancelReason: dto.reason || null,
          ...(refund ? { paymentStatus: refund.paymentStatus } : {}),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }

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
        // Tiền hoàn là dòng REFUND gắn với cọc được hoàn. Dòng CashFlow do E-5 ghi, như với cọc.
        await tx.payment.create({
          data: {
            tenantId,
            orderId: id,
            kind: PaymentKind.REFUND,
            method: refund.method,
            amount: refund.amount,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            refundOfPaymentId: refund.refundOfPaymentId,
            locationId: order.branchId,
            createdById: user.userId,
            note: dto.reason || null,
          },
        });
      }
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
