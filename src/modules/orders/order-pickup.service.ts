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
import {
  assertPickupReady,
  assertStorePickup,
  pickupAmountDue,
} from './order-pickup.rules';
import { assigneeClaim } from './order-handler';
import { buildSepayQrUrl, requireTenantBanking } from './tenant-banking';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import {
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  DeliveryCollectionMethod,
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
        note: true,
        payments: {
          select: {
            id: true,
            kind: true,
            method: true,
            status: true,
            amount: true,
            paymentReference: true,
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
   * Gọi lại với QR khi khoản chờ còn đúng số tiền thì dùng lại khoản đó, để mã QR khách đang quét không đổi.
   */
  async collect(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: PickupCollectDto,
  ) {
    const { order, access } = await this.loadPickupOrder(user, tenantId, id);
    const amountDue = pickupAmountDue(
      Number(order.grandTotal),
      order.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    );
    if (amountDue === 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
        message: 'Nothing is left to collect on this order',
      });
    }

    const pending = order.payments.filter(
      (p) =>
        p.kind === PaymentKind.BALANCE &&
        p.method === PaymentMethod.SEPAY &&
        p.status === PaymentRecordStatus.PENDING,
    );
    const now = new Date();

    if (dto.method === DeliveryCollectionMethod.CASH) {
      await this.prisma.$transaction(async (tx) => {
        // Khách trả tiền mặt thay vì quét QR: huỷ khoản QR đang chờ, nếu tiền vừa về thì dừng.
        for (const payment of pending) {
          const cancelled = await tx.payment.updateMany({
            where: { id: payment.id, status: PaymentRecordStatus.PENDING },
            data: { status: PaymentRecordStatus.CANCELLED },
          });
          if (cancelled.count !== 1) {
            throw new ConflictException({
              code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
              message: 'The transfer has just arrived, please reload',
            });
          }
        }
        const claimed = await tx.order.updateMany({
          where: {
            id,
            tenantId,
            status: OrderStatus.PACKED,
            ...assigneeClaim(access, user),
          },
          data: { paymentStatus: OrderPaymentStatus.PAID },
        });
        if (claimed.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The order has just changed, please reload',
          });
        }
        await tx.payment.create({
          data: {
            tenantId,
            orderId: id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.CASH,
            amount: amountDue,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: order.branchId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      });
      return {
        order: await this.orders.findOne(user, tenantId, id),
        payment: null,
      };
    }

    const banking = await requireTenantBanking(this.prisma, tenantId);
    const reusable = pending.find((p) => Number(p.amount) === amountDue);
    let reference = reusable?.paymentReference ?? null;
    if (!reusable) {
      reference = generateReference(REFERENCE_PREFIX.ORDER);
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({
          where: {
            id: { in: pending.map((p) => p.id) },
            status: PaymentRecordStatus.PENDING,
          },
          data: { status: PaymentRecordStatus.CANCELLED },
        });
        await tx.payment.create({
          data: {
            tenantId,
            orderId: id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.SEPAY,
            amount: amountDue,
            status: PaymentRecordStatus.PENDING,
            paymentReference: reference,
            locationId: order.branchId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      });
    }
    return {
      order: await this.orders.findOne(user, tenantId, id),
      payment: {
        reference: reference!,
        amount: amountDue,
        status: PaymentRecordStatus.PENDING,
        qrUrl: buildSepayQrUrl(banking, amountDue, reference!),
      },
    };
  }
}
