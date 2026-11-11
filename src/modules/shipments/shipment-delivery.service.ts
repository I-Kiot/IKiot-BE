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

/**
 * Giao xong và thu tiền khi giao (C-5) cho lần giao nội bộ (shipper / thợ của shop):
 * - Đã cọc đủ → COMPLETED.
 * - Tiền mặt → RECEIVED; khoản CASH còn ở tay shipper (`remittanceStatus` PENDING) tới khi chủ xác nhận (A-10).
 * - QR → RECEIVED; khoản SEPAY chờ webhook, đủ tiền thì COMPLETED. Khách không chuyển thì shipper bấm `payCash`.
 * - Chuyển thiếu: khoản QR thành PAID với số thực nhận, đơn PARTIALLY_PAID và vẫn RECEIVED; shipper thu nốt phần còn lại bằng mã mới (`reissueQr`) hay tiền mặt (`payCash`).
 * Lần giao qua ĐVVC ngoài không đi qua đây (hãng tự báo về, C-4). Dòng thu chi ghi lúc tiền đổi chủ (QR về / chủ nhận tiền shipper nộp), không ở bước giao.
 */
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

  /**
   * Lịch sử giao của người gọi: mọi trạng thái, kèm số liệu từng thẻ và số tiền đã thu. Khoảng ngày theo lúc kết thúc (`deliveredAt`, hoặc `updatedAt` với lần không giao được), nhưng không bao giờ ẩn lần còn mở: lần giao dở từ sáu tuần trước vẫn phải được thẻ “cần giao” đếm.
   * Số liệu bỏ qua `status` và `search` nhưng vẫn theo khoảng ngày, để thẻ khớp danh sách khi bấm vào.
   */
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

    // Kiểm tra dưới đây chỉ để báo lỗi sớm và rõ; chốt chặn thật là các câu ghi có điều kiện trong transaction.
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

    // Số còn phải thu tính từ các khoản đã thu thật (không phải `tổng − cọc`), và được tính lại trong transaction sau khi khoá đơn.
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

      // Trạng thái thanh toán không đặt tay ở đây: khoản tiền mặt ghi bên dưới rồi `syncOrderPaymentStatus` suy ra (tiền mặt nghĩa là khách đã trả đủ, dù tiền còn ở tay shipper).
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
      // Sau khi chiếm được lần giao và đơn: số còn phải thu tính lại từ các khoản đã đọc trong transaction (đơn đã khoá). Lệch so với số shipper thấy lúc bấm thì dừng, không ghi sai số.
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

  /**
   * Đã giao bằng QR nhưng khách không chuyển (hay chuyển thiếu): shipper thu tiền mặt cho phần còn lại. Còn phải thu (`due`) lớn hơn 0 là đủ, KHÔNG cần có khoản QR đang chờ (khách chuyển thiếu rồi trả nốt tiền mặt).
   * Khoản QR còn mở (nếu có) bị huỷ; ghi khoản tiền mặt đúng bằng `due` (chờ nộp lại cho chủ); đơn giữ RECEIVED. Số tiền do server tính, không nhận từ client.
   */
  async payCash(user: AuthUser, tenantId: string, id: string, dto: PayCashDto) {
    const shipment = await this.loadShipment(tenantId, id);
    const access = deliveryActorAccess(user, shipment);

    const now = new Date();
    let collected = 0;
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, shipment.order.id);
      // Đọc đơn và các khoản SAU khoá: tiền vừa về (webhook giữ khoá trước) thì đơn đã COMPLETED hay hết phải thu, và dừng ở đây.
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
      // Khoản QR còn mở (mã hết hạn cũng vậy) hết hiệu lực. Tiền vừa về thì khoản đã PAID, không nằm trong danh sách mở.
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
        // Chỉ để lệnh chiếm là một lệnh thật (nhảy updatedAt); trạng thái thanh toán do `syncOrderPaymentStatus` suy ra sau khi ghi khoản tiền mặt.
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

  /**
   * Shipper tạo lại mã QR cho phần còn lại: mã cũ đã hết hạn (khách vẫn muốn chuyển khoản) hay khách đã chuyển thiếu một phần. Điều kiện là đơn RECEIVED và còn phải thu (`due`) lớn hơn 0; không cần khoản QR trước đó còn mở.
   * Mã còn hạn đúng số tiền thì trả nguyên chi tiết, không đổi gì (bấm hai lần không sinh hai mã). Ngược lại các khoản QR còn mở bị huỷ và khoản mới có số tiền = `due` (không phải số của khoản cũ), mã tham chiếu mới, hạn mới.
   * Chuyển khoản vào mã cũ sau đó bị từ chối (PAYMENT_SUPERSEDED) và báo chủ shop. Không có sự kiện trên đơn: đơn không đổi gì.
   */
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
      // Mã còn hạn, đúng số tiền, và là mã duy nhất còn mở thì giữ nguyên: màn hình khác vừa tạo lại, hay bấm đúp.
      const live = open.find(
        (payment) =>
          payment.status === PaymentRecordStatus.PENDING &&
          !isQrExpired(payment, now) &&
          toDong(payment.requestedAmount ?? payment.amount) === due,
      );
      if (live && open.length === 1) return;

      await cancelCounterQr(tx, open, user.userId, now);
      // Đơn vẫn chờ tiền (RECEIVED, chưa PAID), và người bấm vẫn phụ trách đơn nếu nhờ đó mà được phép. Ghi updatedAt để câu UPDATE là một lệnh chiếm thật.
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

  /**
   * Tiền QR lúc giao / tại quầy đã về, nhận các tham số rời (test và tích hợp gọi trực tiếp). Webhook thật gọi `settleSepayTransfer` với giao dịch đã chuẩn hoá.
   */
  settleSepayBalance(
    tenantId: string,
    paymentReference: string,
    sepayTransactionId: string | null,
    transferAmount: number,
    now: Date = new Date(),
    meta: Partial<Omit<SepayTransfer, 'dedupeKey' | 'amount'>> = {},
  ): Promise<boolean> {
    return this.settleSepayTransfer(
      tenantId,
      paymentReference,
      buildSepayTransfer({
        ...meta,
        sepayTransactionId,
        amount: transferAmount,
      }),
      now,
    );
  }

  /**
   * Tiền QR lúc giao / tại quầy đã về (webhook SePay gọi khi nhánh bán tại quầy không khớp). Trả `true` nếu mã thuộc một khoản của đơn có giao / khách tới lấy (đã xử lý: chốt, chốt thiếu, trùng, hoặc từ chối), `false` nếu không phải mã của ta.
   * Không ném lỗi nghiệp vụ: SePay gọi lại mọi câu trả lời khác 200. Toàn bộ chốt tiền nằm ở `processSepayTransfer` (`sepay-settlement.ts`), dùng chung với đơn quầy.
   * Hết hạn tính TRƯỚC khi quyết định. Khoản còn mở và đơn còn chờ khoản này thì chốt, kể cả khi mã đã hết hạn (tiền về thật; `lateAfterExpiry` trên sự kiện). Chuyển thiếu là khoản trả một phần: đơn chưa hoàn thành, shipper tạo mã mới cho phần còn lại hay thu tiền mặt.
   * Khoản đã huỷ (tiền mặt, mã mới, đơn huỷ), đã thu bằng giao dịch khác, hay đơn không còn chờ thì KHÔNG chốt: ghi sổ REJECTED + dòng thu chi chưa gắn đơn và báo chủ shop hoàn / đối soát.
   */
  async settleSepayTransfer(
    tenantId: string,
    paymentReference: string,
    transfer: SepayTransfer,
    now: Date = new Date(),
  ): Promise<boolean> {
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
    if (result.kind === 'NOT_OURS') return false;
    if (result.kind === 'SETTLED') {
      await notifySettled({ notifications: this.notifications }, result);
    }
    return true;
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

  /** Báo người phụ trách và chủ shop: shipper đang giữ tiền mặt, chờ nộp lại (A-10). Không bao giờ ném lỗi. */
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

/**
 * Số tiền shipper thu phải khớp đúng số còn phải thu (chốt 2026-10-06: chỉ xử lý thu đủ 100%).
 * Không còn gì phải thu thì chỉ nhận `NONE` với số thu 0; còn phải thu thì không được `NONE` và số thu phải đúng bằng số đó.
 */
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
