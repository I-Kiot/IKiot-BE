import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceService } from '../invoices/invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import { requireTenantBanking } from '../orders/tenant-banking';
import {
  buildSepayTransfer,
  isQrExpired,
  newQrExpiresAt,
  type SepayTransfer,
} from '../orders/sepay-qr';
import {
  notifySettled,
  processSepayTransfer,
  type SepaySettled,
} from '../orders/sepay-settlement';
import { lockOrder } from '../orders/order-lock';
import { syncOrderPaymentStatus } from '../orders/payment-status';
import { completedData } from '../orders/order-status';
import { postSale } from '../orders/sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { cancelCounterQr, openQrPayments } from '../orders/payment-cancel';
import { toDong } from '../../common/utils/money';
import { DeliverShipmentDto } from './dto/deliver-shipment.dto';
import { PayCashDto } from './dto/pay-cash.dto';
import {
  amountStillDueOf,
  loadShipmentDetail,
  localDayWindow,
  SHIPMENT_SUMMARY_INCLUDE,
  shipmentSearchWhere,
  toSummary,
} from './shipment-view';
import {
  MY_HISTORY_ACTIVE,
  QueryMyHistoryDto,
} from './dto/query-my-history.dto';
import { paginate } from '../../common/utils/pagination';
import type { Prisma } from '../../../generated/prisma/client';
import {
  deliveryActorAccess,
  ON_THE_ROAD_STATUSES,
  onTheRoadWhere,
} from './shipment-actor';
import {
  OrderPaymentStatus,
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  DeliveryCollectionMethod,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import {
  CarrierType,
  FINAL_SHIPMENT_STATUSES,
  ShipmentEventSource,
  ShipmentStatus,
} from '../../common/constants/shipment-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import type { AuthUser } from '../../common/types/auth-user.type';
import { OrderEventType } from '../../common/constants/order-event-type';
import {
  recordOrderEvent,
  shipmentRef,
  userActor,
} from '../orders/order-events';

const DELIVERY_SELECT = {
  id: true,
  status: true,
  carrierType: true,
  driverId: true,
  trackingCode: true,
  fulfillment: { select: { locationId: true } },
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      assigneeId: true,
      branchId: true,
      grandTotal: true,
      depositAmount: true,
      payments: { select: { kind: true, status: true, amount: true } },
    },
  },
} as const;

/** Giao xong và thu tiền khi giao (shipper nội bộ). */
/** Kết quả xử lý tiền SePay. */
export type SepayDeliveryOutcome =
  { kind: 'NOT_OURS' } | { kind: 'HANDLED'; settled: SepaySettled | null };

@Injectable()
export class ShipmentDeliveryService {
  private readonly logger = new Logger(ShipmentDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly invoices: InvoiceService,
  ) {}

  async listMine(user: AuthUser, tenantId: string) {
    const rows = await this.prisma.shipment.findMany({
      where: {
        tenantId,
        driverId: user.userId,
        status: { notIn: [...FINAL_SHIPMENT_STATUSES] },
      },
      include: SHIPMENT_SUMMARY_INCLUDE,
      orderBy: [
        { scheduledDate: { sort: 'asc', nulls: 'last' } },
        { createdAt: 'asc' },
      ],
    });
    return rows.map(toSummary);
  }

  /** Lịch sử giao của người gọi kèm số liệu. */
  async listMyHistory(
    user: AuthUser,
    tenantId: string,
    query: QueryMyHistoryDto,
  ) {
    const final = [...FINAL_SHIPMENT_STATUSES];
    const window = localDayWindow(query.from, query.to);
    const mine: Prisma.ShipmentWhereInput = {
      tenantId,
      driverId: user.userId,
      ...(window
        ? {
            OR: [
              { status: { notIn: final } },
              { deliveredAt: window },
              { deliveredAt: null, updatedAt: window },
            ],
          }
        : {}),
    };
    const where: Prisma.ShipmentWhereInput = {
      AND: [
        mine,
        query.status === MY_HISTORY_ACTIVE
          ? { status: { notIn: final } }
          : query.status
            ? { status: query.status }
            : {},
        query.search ? shipmentSearchWhere(query.search) : {},
      ],
    };

    const [total, rows, counts, collected] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        include: SHIPMENT_SUMMARY_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.shipment.groupBy({
        by: ['status'],
        where: mine,
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          tenantId,
          kind: PaymentKind.BALANCE,
          status: PaymentRecordStatus.PAID,
          collectedById: user.userId,
          ...(window ? { createdAt: window } : {}),
        },
        _sum: { amount: true },
      }),
    ]);

    // Một query cho các collection của trang, không phải một query mỗi dòng.
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        orderId: { in: rows.map((row) => row.orderId) },
        kind: PaymentKind.BALANCE,
        collectedById: user.userId,
        status: {
          in: [PaymentRecordStatus.PAID, PaymentRecordStatus.PENDING],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { orderId: true, method: true, amount: true, status: true },
    });
    const collectionByOrder = new Map<
      string,
      { method: string; amount: number; status: string }
    >();
    for (const payment of payments) {
      if (collectionByOrder.has(payment.orderId)) continue; // Dòng đầu là mới nhất, nên bỏ qua các dòng sau.
      collectionByOrder.set(payment.orderId, {
        method: payment.method,
        amount: Number(payment.amount),
        status: payment.status,
      });
    }

    const countOf = (status: string) =>
      counts.find((row) => row.status === status)?._count._all ?? 0;
    const summary = {
      active: counts
        .filter((row) => !FINAL_SHIPMENT_STATUSES.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0),
      delivered: countOf(ShipmentStatus.DELIVERED),
      failed: countOf(ShipmentStatus.FAILED),
      returned: countOf(ShipmentStatus.RETURNED),
      cancelled: countOf(ShipmentStatus.CANCELLED),
      collectedTotal: Number(collected._sum.amount ?? 0),
    };

    const data = rows.map((row) => ({
      ...toSummary(row),
      collection: collectionByOrder.get(row.orderId) ?? null,
    }));
    return { ...paginate(data, total, query.page, query.limit), summary };
  }

  async deliver(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: DeliverShipmentDto,
  ) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);

    // Kiểm sớm để báo lỗi rõ.
    if (shipment.carrierType !== CarrierType.INTERNAL) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DELIVER_INTERNAL_ONLY,
        message:
          'Only our own shippers confirm a delivery; a carrier reports its own',
      });
    }
    if (shipment.order.status !== OrderStatus.SHIPPING) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_ORDER_NOT_SHIPPING,
        message: `The order is ${shipment.order.status}, not on its way`,
      });
    }
    if (!ON_THE_ROAD_STATUSES.includes(shipment.status)) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: `A ${shipment.status} shipment cannot be delivered`,
      });
    }
    if (dto.proofPhotoUrls.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_PROOF_REQUIRED,
        message: 'A delivery needs at least one proof photo',
      });
    }

    // Tính lại số còn phải thu trong transaction.
    const amountDue = amountStillDueOf(shipment.order);
    assertCollectionMatches(amountDue, dto.paymentMethod, dto.collectedAmount);

    const method = dto.paymentMethod;
    if (method === DeliveryCollectionMethod.BANK_TRANSFER_QR) {
      // Không có tài khoản nhận tiền thì không dựng được mã QR cho khách quét.
      await requireTenantBanking(this.prisma, tenantId);
    }

    const nextOrderStatus =
      method === DeliveryCollectionMethod.NONE
        ? OrderStatus.COMPLETED
        : OrderStatus.RECEIVED;

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, shipment.order.id);
      const claimed = await tx.shipment.updateMany({
        where: onTheRoadWhere(id, access, user),
        data: {
          status: ShipmentStatus.DELIVERED,
          deliveredAt: now,
          proofPhotoUrls: dto.proofPhotoUrls,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.SHIPMENT_STATUS_INVALID,
          message: 'The shipment has just changed, please reload',
        });
      }
      await tx.shipmentEvent.create({
        data: {
          shipmentId: id,
          status: ShipmentStatus.DELIVERED,
          source: ShipmentEventSource.MANUAL,
          note: dto.note ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          createdById: user.userId,
        },
      });

      // Trạng thái thanh toán suy ra sau khi ghi khoản tiền mặt.
      const orderData =
        nextOrderStatus === OrderStatus.COMPLETED
          ? completedData(now)
          : { status: nextOrderStatus };
      const orderClaimed = await tx.order.updateMany({
        where: {
          id: shipment.order.id,
          tenantId,
          status: OrderStatus.SHIPPING,
        },
        data: orderData,
      });
      if (orderClaimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }
      // Số phải thu lệch so với lúc bấm thì dừng.
      const freshPayments = await tx.payment.findMany({
        where: { orderId: shipment.order.id },
        select: { kind: true, status: true, amount: true },
      });
      if (
        amountStillDueOf({ ...shipment.order, payments: freshPayments }) !==
        amountDue
      ) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
          message:
            'The amount due on this order has just changed, please reload',
        });
      }
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: shipment.order.id,
        type: OrderEventType.DELIVERED,
        fromStatus: OrderStatus.SHIPPING,
        toStatus: nextOrderStatus,
        metadata: {
          ...shipmentRef(id, shipment.trackingCode),
          method,
          amount: method === DeliveryCollectionMethod.NONE ? 0 : amountDue,
        },
      });
      // Đã cọc đủ thì COMPLETED ngay ở đây: ghi SALE (hàng đã rời kho lúc xuất) và xuất hoá đơn luôn.
      if (nextOrderStatus === OrderStatus.COMPLETED) {
        await postSale(tx, {
          orderId: shipment.order.id,
          actor: { id: user.userId },
          now,
          source: SalesJournalSource.DELIVERY,
        });
        await this.invoices.issueForOrder(tx, shipment.order.id, user.userId);
      }

      if (method === DeliveryCollectionMethod.CASH) {
        await tx.payment.create({
          data: {
            tenantId,
            orderId: shipment.order.id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.CASH,
            amount: amountDue,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: shipment.order.branchId,
            collectedById: user.userId,
            remittanceStatus: RemittanceStatus.PENDING,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
        await syncOrderPaymentStatus(tx, shipment.order.id);
      }
      if (method === DeliveryCollectionMethod.BANK_TRANSFER_QR) {
        // Mã ORD… mới làm nội dung chuyển khoản – webhook SePay nhận ra khoản này nhờ nó.
        await tx.payment.create({
          data: {
            tenantId,
            orderId: shipment.order.id,
            kind: PaymentKind.BALANCE,
            method: PaymentMethod.SEPAY,
            amount: amountDue,
            requestedAmount: amountDue,
            status: PaymentRecordStatus.PENDING,
            paymentReference: generateReference(REFERENCE_PREFIX.ORDER),
            expiresAt: newQrExpiresAt(now),
            locationId: shipment.order.branchId,
            collectedById: user.userId,
            createdById: user.userId,
            note: dto.note ?? null,
          },
        });
      }
    });

    // Sau commit: transaction rollback thì không có thông báo nào.
    if (method === DeliveryCollectionMethod.CASH) {
      await this.notifyCashHeld(tenantId, shipment.order, amountDue);
    }
    // Có khoản QR thì chi tiết trả kèm `payment.qrUrl` để shipper đưa khách quét.
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  /** Shipper thu tiền mặt cho phần còn lại. */
  async payCash(user: AuthUser, tenantId: string, id: string, dto: PayCashDto) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);

    const now = new Date();
    let collected = 0;
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, shipment.order.id);
      // Đọc lại đơn và các khoản sau khoá.
      const order = await tx.order.findUniqueOrThrow({
        where: { id: shipment.order.id },
        select: {
          status: true,
          grandTotal: true,
          depositAmount: true,
          payments: true,
        },
      });
      if (order.status !== OrderStatus.RECEIVED) {
        throw new ConflictException({
          code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
          message: 'The order is not waiting for its payment any more',
        });
      }
      const due = amountStillDueOf(order);
      if (due === 0) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
          message: 'Nothing is left to collect on this order',
        });
      }
      collected = due;
      // Huỷ các khoản QR còn mở.
      await cancelCounterQr(
        tx,
        openQrPayments(order.payments),
        user.userId,
        now,
      );

      // Đơn vẫn chờ tiền (RECEIVED), và người bấm vẫn phụ trách đơn nếu nhờ đó mà được phép.
      const orderWhere: {
        id: string;
        tenantId: string;
        status: string;
        assigneeId?: string;
      } = { id: shipment.order.id, tenantId, status: OrderStatus.RECEIVED };
      if (access === 'ASSIGNEE') {
        orderWhere.assigneeId = user.userId;
      }
      const orderClaimed = await tx.order.updateMany({
        where: orderWhere,
        // Cập nhật updatedAt để lệnh chiếm có hiệu lực.
        data: { updatedAt: now },
      });
      if (orderClaimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }

      const cashPayment = await tx.payment.create({
        data: {
          tenantId,
          orderId: shipment.order.id,
          kind: PaymentKind.BALANCE,
          method: PaymentMethod.CASH,
          amount: due,
          status: PaymentRecordStatus.PAID,
          paidAt: now,
          locationId: shipment.order.branchId,
          collectedById: user.userId,
          remittanceStatus: RemittanceStatus.PENDING,
          createdById: user.userId,
          note: dto.note ?? null,
        },
        select: { id: true },
      });
      await syncOrderPaymentStatus(tx, shipment.order.id);
      // Đơn vẫn RECEIVED (chờ nộp tiền) nên không có chuyển trạng thái.
      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: shipment.order.id,
        type: OrderEventType.CASH_COLLECTED,
        metadata: {
          ...shipmentRef(id, shipment.trackingCode),
          amount: due,
          method: PaymentMethod.CASH,
          paymentId: cashPayment.id,
        },
      });
    });

    await this.notifyCashHeld(tenantId, shipment.order, collected);
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  /** Shipper tạo lại mã QR cho phần còn lại. */
  async reissueQr(user: AuthUser, tenantId: string, id: string) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);
    await requireTenantBanking(this.prisma, tenantId);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, shipment.order.id);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: shipment.order.id },
        select: {
          status: true,
          grandTotal: true,
          depositAmount: true,
          payments: true,
        },
      });
      const due = amountStillDueOf(order);
      if (order.status !== OrderStatus.RECEIVED || due === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING,
          message: 'There is nothing left to collect on this order by QR',
        });
      }
      const open = openQrPayments(order.payments);
      // Mã còn hạn, đúng số tiền thì giữ nguyên.
      const live = open.find(
        (payment) =>
          payment.status === PaymentRecordStatus.PENDING &&
          !isQrExpired(payment, now) &&
          toDong(payment.requestedAmount ?? payment.amount) === due,
      );
      if (live && open.length === 1) return;

      await cancelCounterQr(tx, open, user.userId, now);
      // Chiếm đơn còn chờ tiền.
      const orderWhere: {
        id: string;
        tenantId: string;
        status: string;
        paymentStatus: { not: string };
        assigneeId?: string;
      } = {
        id: shipment.order.id,
        tenantId,
        status: OrderStatus.RECEIVED,
        paymentStatus: { not: OrderPaymentStatus.PAID },
      };
      if (access === 'ASSIGNEE') {
        orderWhere.assigneeId = user.userId;
      }
      const orderClaimed = await tx.order.updateMany({
        where: orderWhere,
        data: { updatedAt: now },
      });
      if (orderClaimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }
      await tx.payment.create({
        data: {
          tenantId,
          orderId: shipment.order.id,
          kind: PaymentKind.BALANCE,
          method: PaymentMethod.SEPAY,
          amount: due,
          requestedAmount: due,
          status: PaymentRecordStatus.PENDING,
          paymentReference: generateReference(REFERENCE_PREFIX.ORDER),
          expiresAt: newQrExpiresAt(now),
          locationId: shipment.order.branchId,
          collectedById: user.userId,
          createdById: user.userId,
        },
      });
    });
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  /** Xử lý tiền QR về (tham số rời, cho test). */
  async settleSepayBalance(
    tenantId: string,
    paymentReference: string,
    sepayTransactionId: string | null,
    transferAmount: number,
    now: Date = new Date(),
    meta: Partial<Omit<SepayTransfer, 'dedupeKey' | 'amount'>> = {},
  ): Promise<boolean> {
    const outcome = await this.settleSepayTransfer(
      tenantId,
      paymentReference,
      buildSepayTransfer({
        ...meta,
        sepayTransactionId,
        amount: transferAmount,
      }),
      now,
    );
    return outcome.kind === 'HANDLED';
  }

  /** Xử lý tiền QR lúc giao / tại quầy từ webhook. */
  async settleSepayTransfer(
    tenantId: string,
    paymentReference: string,
    transfer: SepayTransfer,
    now: Date = new Date(),
  ): Promise<SepayDeliveryOutcome> {
    const result = await processSepayTransfer(
      {
        prisma: this.prisma,
        notifications: this.notifications,
        invoices: this.invoices,
        logger: this.logger,
      },
      {
        tenantId,
        reference: paymentReference,
        transfer,
        scope: 'DELIVERY',
        now,
      },
    );
    if (result.kind === 'NOT_OURS') return { kind: 'NOT_OURS' };
    if (result.kind === 'SETTLED') {
      await notifySettled({ notifications: this.notifications }, result);
      return { kind: 'HANDLED', settled: result };
    }
    return { kind: 'HANDLED', settled: null };
  }

  /** Nạp lần giao cùng đơn của nó; không có trong shop thì 404. */
  private async loadShipment(tenantId: string, id: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, tenantId },
      select: DELIVERY_SELECT,
    });
    if (!shipment) {
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    }
    return shipment;
  }

  /** Báo shipper đang giữ tiền mặt chờ nộp. */
  private async notifyCashHeld(
    tenantId: string,
    order: { id: string; code: string; assigneeId: string | null },
    amount: number,
  ) {
    const owners = await this.notifications.tenantOwners(tenantId);
    await this.notifications.notify({
      tenantId,
      recipientIds: [order.assigneeId, ...owners],
      referenceId: order.id,
      ...OrderNotificationTemplates.cashAwaitingRemittance(
        order.id,
        order.code,
        amount,
      ),
    });
  }
}

/** Số shipper thu phải đúng số còn phải thu. */
function assertCollectionMatches(
  amountDue: number,
  method: string,
  collectedAmount: number,
): void {
  if (amountDue === 0) {
    if (
      method !== DeliveryCollectionMethod.NONE ||
      toDong(collectedAmount) !== 0
    ) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
        message: 'Nothing is left to collect on this order',
      });
    }
    return;
  }
  if (method === DeliveryCollectionMethod.NONE) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
      message: `${amountDue} is still due on this order`,
    });
  }
  if (toDong(collectedAmount) !== amountDue) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
      message: `Collected ${collectedAmount}, but ${amountDue} is due`,
    });
  }
}
