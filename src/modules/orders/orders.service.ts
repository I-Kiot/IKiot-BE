import { postingOf } from '../../common/utils/tenant-scope';
import { LocationType } from '../../common/constants/location-type';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { NotificationService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { publishChange } from '../../common/realtime/change-feed';
import { OrderChanges } from './orders.change-template';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import {
  FulfillmentType,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../../common/constants/inventory-ledger';
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';
import { paginate, skipFor } from '../../common/utils/pagination';
import { narrowToScope } from '../../common/utils/scope-filter';
import { SepayOrderService } from './sepay-order.service';
import { requireTenantBanking } from './tenant-banking';
import {
  buildSepayTransfer,
  isQrExpired,
  qrIssuedBefore,
  SEPAY_DUPLICATE_MESSAGE,
  sepayQrView,
  type SepayTransfer,
} from './sepay-qr';
import { notifySettled, processSepayTransfer } from './sepay-settlement';
import { postOtherIncome, postPosReturn, postSale } from './sales-journal';
import { SalesJournalSource } from '../../common/constants/sales-journal';
import { OrderPricingService } from './order-pricing.service';
import { lockOrder } from './order-lock';
import { completedData } from './order-status';
import { toDong } from '../../common/utils/money';
import {
  derivePaymentStatus,
  paymentRowsOf,
  paymentTotals,
  syncOrderPaymentStatus,
} from './payment-status';
import { openPosQrPayment, recordPosPayments } from './pos-payments';
import {
  recordRefund,
  recordRefundPayment,
  resolveRefund,
} from './order-refund';
import { cancelCounterQr, openQrPayments } from './payment-cancel';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { buildOrderItemRows, expandCombos } from './order-combo';
import {
  INSTANT_COMPLETE_METHODS,
  OrderStatus,
  VALID_ORDER_TRANSITIONS,
} from './order.constants';
import {
  CancelPosSaleDto,
  CreatePosOrderDto,
  PayOfflineOrderDto,
  QueryOrderDto,
} from './dto/order.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { InvoiceService } from '../invoices/invoices.service';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  WALK_IN_CUSTOMER_CODE,
  WALK_IN_CUSTOMER_NAME,
} from '../../common/constants/walk-in-customer';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';
import { OrderEventType } from '../../common/constants/order-event-type';
import {
  recordOrderEvent,
  SYSTEM_ACTOR,
  userActor,
  type OrderEventActor,
} from './order-events';

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  branch: BRANCH_NAME_SELECT,
  user: {
    select: {
      id: true,
      phoneNumber: true,
      profileFirstName: true,
      profileLastName: true,
    },
  },
  items: {
    include: {
      productItem: { select: { id: true, sku: true, productName: true } },
    },
  },
  appliedPromotions: true,
  // Đơn quầy giờ có dòng Payment như mọi đơn (Phase 3): FULL, CHANGE, và QR còn chờ.
  payments: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

/** Service đơn hàng: bán tại quầy, đổi trạng thái, thanh toán SePay. */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
    private readonly sepay: SepayOrderService,
    private readonly pricing: OrderPricingService,
    private readonly invoices: InvoiceService,
  ) {}

  /** Bán tại quầy: thu tiền và trừ kho ngay. */
  async createPosSale(
    user: AuthUser,
    tenantId: string,
    dto: CreatePosOrderDto,
  ) {
    const userId = user.userId;
    // Kiểm phạm vi chi nhánh khi lên đơn.
    const scope = this.branchScope(user);
    if (scope.branchId !== undefined && dto.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'You can only create orders for your own branch',
      });
    }

    // Bán tại quầy vẫn chỉ ở chi nhánh; kho chỉ tạo đơn tay.
    const branch = await this.prisma.branch.findFirst({
      where: {
        id: dto.branchId,
        tenantId,
        location: { type: LocationType.BRANCH },
      },
      select: { id: true },
    });
    if (!branch)
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });

    if (dto.customerId)
      await this.assertCustomerExists(tenantId, dto.customerId);
    const isSepay = dto.paymentMethod === PaymentMethod.SEPAY;
    const banking = isSepay
      ? await requireTenantBanking(this.prisma, tenantId)
      : null;

    const priced = await this.pricing.priceOrder(tenantId, dto);
    const { lines, appliedPromotions, discountType, discountValue } = priced;
    const grandTotal = this.pricing.grandTotalOf(
      lines,
      discountType,
      discountValue,
    );

    // Mở combo thành các dòng lá trước transaction.
    const components = await expandCombos(this.prisma, tenantId, lines);
    // Đơn quầy không lưu kho xuất và VAT trên dòng.
    const itemRows = buildOrderItemRows(
      lines.map((line) => ({ ...line, sourceLocationId: null })),
      components,
      (line) => this.pricing.lineTotalOf(line),
    ).map((row) => ({ ...row, vatRate: undefined }));

    // Tiền khách đưa phải đủ trả hoá đơn.
    if (dto.customerPay !== undefined && toDong(dto.customerPay) < grandTotal) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_CUSTOMER_PAY_TOO_LOW,
        message: `The customer paid ${dto.customerPay}, which is less than the ${grandTotal} due`,
      });
    }
    const change =
      dto.customerPay === undefined
        ? null
        : Math.max(0, toDong(dto.customerPay) - grandTotal);

    const status = INSTANT_COMPLETE_METHODS.includes(dto.paymentMethod)
      ? OrderStatus.COMPLETED
      : OrderStatus.PENDING;
    const paymentReference = this.sepay.generateOrderReference();
    const now = new Date();

    let qrPayment: { expiresAt: Date | null; createdAt: Date } | null = null;
    const { order, crossings } = await this.prisma.$transaction(async (tx) => {
      // Tìm khách vãng lai trong transaction: nếu tạo ngoài thì khi đơn lỗi, dòng khách đó sẽ còn lại.
      const customerId =
        dto.customerId ?? (await this.resolveWalkInCustomer(tx, tenantId));

      const created = await tx.order.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          customerId,
          userId,
          // Người lên đơn quầy là người phụ trách.
          assigneeId: userId,
          // Đơn quầy: người bán là nhân viên bán hàng.
          sellerId: userId,
          confirmedById: userId,
          confirmedAt: now,
          fulfillmentType: FulfillmentType.TAKEAWAY,
          status,
          // Đơn quầy mở ở COMPLETED (thu ngay) thì chốt luôn lúc này: CHECK `orders_completed_at_required`.
          ...(status === OrderStatus.COMPLETED ? { completedAt: now } : {}),
          // Trạng thái thanh toán suy ra sau khi ghi khoản tiền.
          subtotal: this.pricing.subtotalOf(lines),
          // Mã tham chiếu của quầy đồng thời là mã đơn, để hóa đơn và chuyển khoản gọi tên đơn giống nhau.
          code: paymentReference,
          paymentMethod: dto.paymentMethod,
          paymentReference,
          grandTotal,
          customerPay: dto.customerPay,
          change,
          note: dto.note,
          discountType,
          discountValue,
          // Một câu INSERT cho mọi dòng để con của combo tham chiếu được cha được chèn cùng lúc.
          items: { createMany: { data: itemRows } },
          appliedPromotions: { create: appliedPromotions },
        },
        include: ORDER_INCLUDE,
      });
      // Lượt dùng khuyến mãi ghi cùng transaction với đơn quầy (trước đây quầy gọi `/promotions/apply` sau).
      await this.pricing.recordPromotionUsage(tx, tenantId, {
        orderId: created.id,
        branchId: dto.branchId,
        customerId,
        applied: appliedPromotions,
        userId,
      });

      // Trừ kho và theo dõi ngưỡng tồn thấp.
      const lowStock: (Inventory | null)[] = [];
      // Chỉ dòng có hàng mới trừ kho; mỗi dòng sổ ghi dòng đơn của nó.
      for (const item of created.items) {
        if (!STOCKED_LINE_TYPES.includes(item.lineType)) continue;
        const after = await this.inventory.deductStock(tx, {
          tenantId,
          productItemId: item.productItemId,
          locationId: dto.branchId, // id Branch cũng là id Location
          quantity: item.quantity,
          label: item.sku ?? item.productItemId,
          ledger: {
            type: InventoryTxType.SALE,
            referenceType: InventoryRefType.ORDER,
            referenceId: created.id,
            createdById: userId,
            orderItemId: item.id,
          },
        });
        lowStock.push(this.inventory.lowStockCrossing(after, -item.quantity));
      }

      // Ghi khoản thanh toán: nhận ngay thì FULL (+ CHANGE), SePay thì chờ webhook.
      if (status === OrderStatus.COMPLETED) {
        await recordPosPayments(tx, {
          order: created,
          method: dto.paymentMethod,
          amountDue: grandTotal,
          customerPay: dto.customerPay ?? null,
          kind: PaymentKind.FULL,
          actorId: userId,
          now,
        });
        // Đơn quầy mở ở COMPLETED: hàng đã rời kệ ở trên (giá vốn đọc từ sổ lô), ghi SALE ngay.
        await postSale(tx, {
          orderId: created.id,
          actor: { id: userId },
          now,
          source: SalesJournalSource.POS_SALE,
        });
      } else {
        qrPayment = await openPosQrPayment(tx, {
          order: created,
          kind: PaymentKind.FULL,
          amount: grandTotal,
          reference: paymentReference,
          issuedAt: created.createdAt,
          actorId: userId,
        });
      }

      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: created.id,
        type: OrderEventType.CREATED,
        fromStatus: null,
        toStatus: status,
        metadata: {
          fulfillmentType: FulfillmentType.TAKEAWAY,
          paymentMethod: dto.paymentMethod,
          grandTotal,
        },
      });

      // Tạo hoá đơn cho đơn quầy.
      await this.invoices.ensurePending(tx, created.id);
      if (status === OrderStatus.COMPLETED) {
        await this.invoices.issueForOrder(tx, created.id, userId);
      }

      // Đọc lại sau khi ghi tiền: phản hồi mang trạng thái thanh toán đã suy ra và các khoản.
      const settled = await tx.order.findUniqueOrThrow({
        where: { id: created.id },
        include: ORDER_INCLUDE,
      });
      return { order: settled, crossings: lowStock };
    });

    await this.inventory.notifyLowStock(crossings);

    // Lấy link QR qua `sepayQrView`.
    const qr =
      isSepay && banking
        ? sepayQrView(
            banking,
            {
              amount: grandTotal,
              reference: paymentReference,
              createdAt: order.createdAt,
              expiresAt: (qrPayment as { expiresAt: Date | null } | null)
                ?.expiresAt,
            },
            'issue',
          )
        : null;
    return {
      order: this.toResponse(order),
      qrUrl: qr?.qrUrl ?? null,
      qrExpiresAt: qr ? qr.expiresAt.toISOString() : null,
    };
  }

  async findAll(user: AuthUser, tenantId: string, query: QueryOrderDto) {
    const scope = this.branchScope(user);
    const where: Prisma.OrderWhereInput = { tenantId, ...scope };
    if (query.status) where.status = query.status;
    if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
    // Filter của client chỉ thu hẹp phạm vi.
    const branchId = narrowToScope(
      scope.branchId,
      query.branchId,
      'You can only view orders for your own branch',
    );
    if (branchId) where.branchId = branchId;

    // Lọc theo khách có tên thắng tìm tự do, như service cũ: gửi cả hai thì mã khách là điều cụ thể hơn.
    if (query.customerId) {
      where.customerId = query.customerId;
    } else if (query.search) {
      where.customer = {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    if (query.fromDate || query.toDate) {
      where.createdAt = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, tenantId: string, id: string) {
    return this.toResponse(await this.findRow(user, tenantId, id));
  }

  /** Các chi nhánh tài khoản được xem đơn. */
  /** Các chi nhánh tài khoản được đọc/ghi đơn. */
  branchScope(user: AuthUser): { branchId?: string } {
    if (can(user, 'orders', 'view_all')) return {};
    const posting = postingOf(user);
    if (!posting) {
      // Không gắn nơi nào và không có view_all: không đọc được đơn của nơi nào.
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }
    return { branchId: posting };
  }

  /** Chuyển trạng thái đơn quầy kèm tồn kho và tiền tương ứng. */
  async updateStatus(
    user: AuthUser,
    tenantId: string,
    id: string,
    newStatus: string,
  ) {
    const order = await this.findRow(user, tenantId, id);

    // Đơn chờ SePay không được chốt COMPLETED bằng PATCH.
    if (
      newStatus === OrderStatus.COMPLETED &&
      order.status === OrderStatus.PENDING &&
      order.paymentMethod === PaymentMethod.SEPAY
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_USE_PAY_OFFLINE,
        message:
          'A counter sale waiting for its transfer is completed with POST /orders/:id/pay-offline, not by changing its status',
      });
    }

    // Đơn hành trình không đổi trạng thái qua route này.
    const allowed =
      order.fulfillmentType === FulfillmentType.TAKEAWAY
        ? (VALID_ORDER_TRANSITIONS[order.status] ?? [])
        : [];
    if (!allowed.includes(newStatus)) {
      throw new ConflictException({
        code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
        message: `An order cannot move from ${order.status} to ${newStatus}`,
      });
    }

    // Huỷ đơn quầy chờ QR dùng chung hàm với nút huỷ và cron.
    if (
      newStatus === OrderStatus.CANCELLED &&
      order.status === OrderStatus.PENDING &&
      order.paymentMethod === PaymentMethod.SEPAY
    ) {
      const done = await this.prisma.$transaction((tx) =>
        this.cancelPendingPosSale(tx, tenantId, order, userActor(user), {
          reason: 'Hủy đơn thủ công',
          cancelledById: user.userId,
          allowPaid: true,
        }),
      );
      if (!done) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }
      this.announceCancelled(order, 'MANUAL');
      return this.toResponse(await this.findRow(user, tenantId, id));
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, id);
      const claimed = await tx.order.updateMany({
        where: { id, status: order.status },
        data: { status: newStatus },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }

      // Trả hàng đơn quầy hoàn đúng số tiền đang giữ.
      let refundPaymentId: string | undefined;
      let refundAmount = 0;
      if (newStatus === OrderStatus.RETURNED) {
        const rows = (
          await tx.payment.findMany({ where: { orderId: id } })
        ).map((p) => ({ ...p, amount: Number(p.amount) }));
        const refund = resolveRefund(rows, paymentTotals(rows).net, undefined);
        if (refund && refund.amount > 0) {
          // recordRefund: khoản REFUND + dòng chi + đồng bộ trạng thái thanh toán + sự kiện REFUNDED.
          const refunded = await recordRefund(tx, {
            order,
            amount: refund.amount,
            cap: 'HELD',
            method: refund.method,
            actor: user,
            reason: 'POS_RETURN',
            note: null,
            description: `Trả hàng đơn ${order.code}`,
            now,
          });
          refundPaymentId = refunded.paymentId;
          refundAmount = refund.amount;
        } else {
          await syncOrderPaymentStatus(tx, id);
        }
      }

      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: id,
        type: OrderEventType.STATUS_CHANGED,
        fromStatus: order.status,
        toStatus: newStatus,
        ...(refundPaymentId
          ? {
              metadata: {
                refundAmount,
                paymentId: refundPaymentId,
              },
            }
          : {}),
      });

      // Huỷ và trả chỉ làm tồn tăng nên không kiểm tồn thấp.
      if (
        newStatus === OrderStatus.CANCELLED ||
        newStatus === OrderStatus.RETURNED
      ) {
        // Trả hàng về đúng các lô đơn đã lấy.
        for (const line of order.items.filter((item) =>
          STOCKED_LINE_TYPES.includes(item.lineType),
        )) {
          await this.inventory.returnDrawn(tx, {
            tenantId,
            productItemId: line.productItemId,
            toLocationId: order.branchId, // id Branch cũng là id Location
            quantity: Number(line.quantity),
            drawnBy: { orderItemId: line.id },
            ledger: {
              type:
                newStatus === OrderStatus.CANCELLED
                  ? InventoryTxType.SALE_REVERSAL
                  : InventoryTxType.RETURN_GOOD,
              referenceType: InventoryRefType.ORDER,
              referenceId: order.id,
              createdById: user.userId,
            },
            ifNeverDrawn: { sourceType: LotSourceType.OPENING },
          });
        }
      }

      if (newStatus === OrderStatus.CANCELLED) {
        await this.invoices.voidPending(tx, order.id);
      }

      if (newStatus === OrderStatus.RETURNED) {
        await this.invoices.adjustForReturn(
          tx,
          order.id,
          `Trả hàng đơn ${order.code}`,
          user.userId,
        );
        // Trả cả đơn quầy: bút toán RETURN âm (hàng đã về lô ở trên nên giá vốn đọc được từ sổ lô).
        await postPosReturn(tx, {
          orderId: order.id,
          actor: { id: user.userId },
          now,
        });
      }

      return tx.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_INCLUDE,
      });
    });

    return this.toResponse(updated);
  }

  /** Huỷ đơn quầy đang chờ QR trong transaction của bên gọi; false nếu đơn không còn chờ. */
  private async cancelPendingPosSale(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: OrderRow,
    actor: OrderEventActor,
    opts: {
      reason: string;
      cancelledById: string | null;
      allowPaid: boolean;
      refundAmount?: number;
      refundMethod?: string;
    },
  ): Promise<boolean> {
    if (!(await lockOrder(tx, tenantId, order.id))) return false;
    const payments = await tx.payment.findMany({
      where: { orderId: order.id },
    });
    const rows = payments.map((p) => ({ ...p, amount: Number(p.amount) }));
    const holdsMoney = payments.some(
      (p) => p.status === PaymentRecordStatus.PAID,
    );
    if (holdsMoney && !opts.allowPaid) return false;
    const refund = opts.allowPaid
      ? resolveRefund(rows, opts.refundAmount, opts.refundMethod)
      : null;

    const now = new Date();
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id,
        tenantId,
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.SEPAY,
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: now,
        cancelledById: opts.cancelledById,
        cancelReason: opts.reason,
      },
    });
    if (claimed.count !== 1) return false;

    // Mã QR còn mở hết hiệu lực cùng đơn (tiền về sau đó bị webhook từ chối và ghi sổ chưa gắn đơn).
    await cancelCounterQr(
      tx,
      openQrPayments(payments),
      opts.cancelledById,
      now,
    );
    let refundPaymentId: string | undefined;
    if (refund && refund.amount > 0) {
      const refunded = await recordRefundPayment(tx, {
        order,
        amount: refund.amount,
        method: refund.method,
        refundOfPaymentId: refund.refundOfPaymentId,
        actorId: opts.cancelledById,
        note: opts.reason,
        description: `Hoàn tiền huỷ đơn ${order.code}`,
        now,
      });
      refundPaymentId = refunded.id;
    }
    const afterCancel = await syncOrderPaymentStatus(tx, order.id);
    // Tiền giữ lại sau khi hoàn ghi là thu nhập khác.
    await postOtherIncome(tx, {
      orderId: order.id,
      kept: afterCancel.net,
      actor: { id: opts.cancelledById },
      now,
      source: SalesJournalSource.POS_CANCEL,
    });

    await recordOrderEvent(tx, actor, {
      tenantId,
      orderId: order.id,
      type: OrderEventType.CANCELLED,
      fromStatus: OrderStatus.PENDING,
      toStatus: OrderStatus.CANCELLED,
      metadata: {
        reason: opts.reason,
        paymentReference: order.paymentReference,
        grandTotal: Number(order.grandTotal),
        ...(refund
          ? {
              refundAmount: refund.amount,
              refundMethod: refund.amount > 0 ? refund.method : null,
              paymentId: refundPaymentId,
            }
          : {}),
      },
    });

    // Trả hàng về đúng các lô đơn đã lấy.
    for (const line of order.items.filter((item) =>
      STOCKED_LINE_TYPES.includes(item.lineType),
    )) {
      await this.inventory.returnDrawn(tx, {
        tenantId,
        productItemId: line.productItemId,
        toLocationId: order.branchId, // id Branch cũng là id Location
        quantity: Number(line.quantity),
        drawnBy: { orderItemId: line.id },
        ledger: {
          type: InventoryTxType.SALE_REVERSAL,
          referenceType: InventoryRefType.ORDER,
          referenceId: order.id,
          createdById: opts.cancelledById,
        },
        ifNeverDrawn: { sourceType: LotSourceType.OPENING },
      });
    }
    await this.invoices.voidPending(tx, order.id);
    return true;
  }

  /** Huỷ đơn quầy chờ QR từ nút "Hủy đơn này". */
  async cancelPosSale(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: CancelPosSaleDto,
  ) {
    const order = await this.findRow(user, tenantId, id);
    if (
      order.fulfillmentType !== FulfillmentType.TAKEAWAY ||
      order.status !== OrderStatus.PENDING ||
      order.paymentMethod !== PaymentMethod.SEPAY
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_PENDING_SEPAY,
        message: 'This order is no longer awaiting SePay payment',
      });
    }
    if (!can(user, 'orders', 'update') && order.userId !== user.userId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_STEP_DENIED,
        message: 'You can only cancel a sale you rang up yourself',
      });
    }

    const done = await this.prisma.$transaction((tx) =>
      this.cancelPendingPosSale(tx, tenantId, order, userActor(user), {
        reason: dto.reason?.trim() || 'Khách không thanh toán QR',
        cancelledById: user.userId,
        allowPaid: true,
        refundAmount: dto.refundAmount,
        refundMethod: dto.refundMethod,
      }),
    );
    if (!done) {
      throw new ConflictException({
        code: ErrorCode.ORDER_PAYMENT_CONFLICT,
        message: 'This order has just been paid or cancelled, please reload',
      });
    }
    this.announceCancelled(order, 'MANUAL');
    return this.toResponse(await this.findRow(user, tenantId, id));
  }

  /** Cron huỷ đơn quầy chờ QR đã quá 15 phút và chưa có tiền. */
  async cancelExpiredPosSales(now: Date = new Date()): Promise<number> {
    const candidates = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.SEPAY,
        fulfillmentType: FulfillmentType.TAKEAWAY,
        createdAt: { lte: qrIssuedBefore(now) },
        payments: { none: { status: PaymentRecordStatus.PAID } },
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    let cancelled = 0;
    for (const order of candidates) {
      const open = openQrPayments(order.payments);
      const expired =
        open.length > 0
          ? open.every((payment) => isQrExpired(payment, now))
          : isQrExpired({ createdAt: order.createdAt }, now);
      if (!expired) continue;
      try {
        const done = await this.prisma.$transaction((tx) =>
          this.cancelPendingPosSale(tx, order.tenantId, order, SYSTEM_ACTOR, {
            reason: 'QR hết hạn',
            cancelledById: null,
            allowPaid: false,
          }),
        );
        if (!done) continue; // webhook hay thu ngân vừa chốt trước
        cancelled += 1;
        this.announceCancelled(order, 'QR_EXPIRED');
        // Phát thay đổi bằng hàm thường để không thêm phụ thuộc vào constructor.
        publishChange(
          this.realtime,
          {
            tenantId: order.tenantId,
            spec: OrderChanges.qrExpiredCancelled,
            target: { subjectId: order.id, code: order.code },
            actor: { source: 'SYSTEM' },
          },
          this.logger,
        );
      } catch (error) {
        this.logger.error(
          `Failed to cancel expired QR order ${order.code}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return cancelled;
  }

  /** Báo màn hình cửa hàng đơn quầy vừa bị huỷ. */
  private announceCancelled(
    order: { id: string; tenantId: string },
    reason: 'QR_EXPIRED' | 'MANUAL',
  ) {
    this.realtime.emitToRoom(`tenant:${order.tenantId}`, 'order:cancelled', {
      orderId: order.id,
      status: OrderStatus.CANCELLED,
      reason,
    });
  }

  /** Chốt đơn quầy chờ SePay bằng tiền mặt hoặc chuyển khoản tay. */
  async payOffline(
    user: AuthUser,
    tenantId: string,
    id: string,
    userId: string,
    dto: PayOfflineOrderDto,
  ) {
    const order = await this.findRow(user, tenantId, id);
    if (
      order.status !== OrderStatus.PENDING ||
      order.paymentMethod !== PaymentMethod.SEPAY
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_PENDING_SEPAY,
        message: 'This order is no longer awaiting SePay payment',
      });
    }

    const paymentMethod = dto.paymentMethod ?? PaymentMethod.CASH;
    const now = new Date();
    let paidNow = 0;
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, id);
      // Đọc lại SAU khoá: webhook có thể vừa chốt hay huỷ đơn.
      const current = await tx.order.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          paymentMethod: true,
          grandTotal: true,
          depositAmount: true,
        },
      });
      if (
        current.status !== OrderStatus.PENDING ||
        current.paymentMethod !== PaymentMethod.SEPAY
      ) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PAYMENT_CONFLICT,
          message: 'This order has just been paid or cancelled, please reload',
        });
      }
      const payments = await tx.payment.findMany({ where: { orderId: id } });
      // Huỷ mã QR đang chờ.
      await cancelCounterQr(tx, openQrPayments(payments), userId, now);
      const derived = derivePaymentStatus(
        current.grandTotal,
        paymentRowsOf({ depositAmount: current.depositAmount, payments }),
      );
      const due = derived.due;
      if (due === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PAYMENT_CONFLICT,
          message: 'Nothing is left to collect on this order',
        });
      }
      const customerPay = toDong(dto.customerPay ?? due);
      if (customerPay < due) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_CUSTOMER_PAY_TOO_LOW,
          message: `The customer paid ${customerPay}, which is less than the ${due} due`,
        });
      }
      paidNow = due;

      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: OrderStatus.PENDING,
          paymentMethod: PaymentMethod.SEPAY,
        },
        data: {
          ...completedData(now),
          paymentMethod,
          customerPay,
          change: Math.max(0, customerPay - due),
          ...(dto.note ? { note: dto.note } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PAYMENT_CONFLICT,
          message: 'This order has just been paid or cancelled, please reload',
        });
      }

      // Ghi khoản tiền, dòng thu chi và trạng thái thanh toán.
      const recorded = await recordPosPayments(tx, {
        order,
        method: paymentMethod,
        amountDue: due,
        customerPay,
        kind: derived.received === 0 ? PaymentKind.FULL : PaymentKind.BALANCE,
        actorId: userId,
        now,
      });

      await recordOrderEvent(tx, userActor(user), {
        tenantId,
        orderId: id,
        type: OrderEventType.PAID_OFFLINE,
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.COMPLETED,
        metadata: {
          method: paymentMethod,
          amount: customerPay,
          change: recorded.change,
          paymentId: recorded.paymentId ?? undefined,
          grandTotal: toDong(current.grandTotal),
        },
      });

      await postSale(tx, {
        orderId: id,
        actor: { id: userId },
        now,
        source: SalesJournalSource.POS_PAY_OFFLINE,
      });
      await this.invoices.issueForOrder(tx, id, userId);
      return tx.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_INCLUDE,
      });
    });

    this.announcePaid(updated, paidNow, paymentMethod, {
      partial: false,
      due: 0,
      paymentStatus: updated.paymentStatus,
    });
    return this.toResponse(updated);
  }

  /** Phát mã QR cho phần còn lại của đơn quầy; mã còn sống đúng số tiền thì dùng lại. */
  async createPosQr(user: AuthUser, tenantId: string, id: string) {
    const order = await this.findRow(user, tenantId, id);
    if (
      order.fulfillmentType !== FulfillmentType.TAKEAWAY ||
      order.status !== OrderStatus.PENDING ||
      order.paymentMethod !== PaymentMethod.SEPAY
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_PENDING_SEPAY,
        message: 'This order is no longer awaiting SePay payment',
      });
    }
    if (!can(user, 'orders', 'update') && order.userId !== user.userId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_STEP_DENIED,
        message: 'You can only take payment on a sale you rang up yourself',
      });
    }
    const banking = await requireTenantBanking(this.prisma, tenantId);

    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, tenantId, id);
      const current = await tx.order.findUniqueOrThrow({
        where: { id },
        select: {
          status: true,
          paymentMethod: true,
          grandTotal: true,
          depositAmount: true,
        },
      });
      if (
        current.status !== OrderStatus.PENDING ||
        current.paymentMethod !== PaymentMethod.SEPAY
      ) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PAYMENT_CONFLICT,
          message: 'This order has just been paid or cancelled, please reload',
        });
      }
      const payments = await tx.payment.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
      });
      const derived = derivePaymentStatus(
        current.grandTotal,
        paymentRowsOf({ depositAmount: current.depositAmount, payments }),
      );
      if (derived.due === 0) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH,
          message: 'Nothing is left to collect on this order',
        });
      }
      const open = openQrPayments(payments);
      const live = open.find(
        (payment) =>
          payment.status === PaymentRecordStatus.PENDING &&
          !isQrExpired(payment, now) &&
          toDong(payment.requestedAmount ?? payment.amount) === derived.due,
      );
      if (live && open.length === 1) {
        return { payment: live, amount: derived.due };
      }
      await cancelCounterQr(tx, open, user.userId, now);
      const payment = await openPosQrPayment(tx, {
        order,
        kind: derived.received === 0 ? PaymentKind.FULL : PaymentKind.BALANCE,
        amount: derived.due,
        reference: generateReference(REFERENCE_PREFIX.ORDER),
        issuedAt: now,
        actorId: user.userId,
      });
      return { payment, amount: derived.due };
    });

    // Mã chỉ phát qua `sepayQrView` (cửa duy nhất); mã vừa tạo hay dùng lại đều còn hạn.
    const view = sepayQrView(
      banking,
      {
        amount: issued.amount,
        reference: issued.payment.paymentReference!,
        expiresAt: issued.payment.expiresAt,
        createdAt: issued.payment.createdAt,
      },
      'issue',
      now,
    );
    return {
      order: this.toResponse(await this.findRow(user, tenantId, id)),
      qrUrl: view.qrUrl,
      qrExpiresAt: view.expiresAt.toISOString(),
      amount: issued.amount,
    };
  }

  /** Xử lý tiền SePay về cho đơn quầy (tham số rời, cho test). */
  completeSepayOrder(
    tenantId: string,
    paymentReference: string,
    sepayTransactionId: string | null,
    transferAmount: number,
    now: Date = new Date(),
    meta: Partial<Omit<SepayTransfer, 'dedupeKey' | 'amount'>> = {},
  ): Promise<{ message: string } | null> {
    return this.completeSepayTransfer(
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

  /** Xử lý tiền SePay về cho đơn quầy; null khi mã không thuộc đơn quầy nào. */
  async completeSepayTransfer(
    tenantId: string,
    paymentReference: string,
    transfer: SepayTransfer,
    now: Date = new Date(),
  ): Promise<{ message: string } | null> {
    const result = await processSepayTransfer(this.sepayDeps(), {
      tenantId,
      reference: paymentReference,
      transfer,
      scope: 'POS',
      now,
    });
    switch (result.kind) {
      case 'NOT_OURS':
        return null;
      case 'DUPLICATE':
        return { message: SEPAY_DUPLICATE_MESSAGE };
      case 'REJECTED':
        return { message: result.message };
      case 'SETTLED': {
        this.announcePaid(result.order, result.amount, PaymentMethod.SEPAY, {
          partial: result.partial,
          due: result.due,
          paymentStatus: result.paymentStatus,
        });
        publishChange(
          this.realtime,
          {
            tenantId: result.order.tenantId,
            spec: result.partial
              ? OrderChanges.qrPartiallyPaid
              : OrderChanges.qrPaid,
            target: { subjectId: result.order.id, code: result.order.code },
            actor: { source: 'WEBHOOK' },
          },
          this.logger,
        );
        // Gửi thông báo vì xác nhận đến sau vài phút.
        await notifySettled(this.sepayDeps(), result);
        return {
          message: result.partial
            ? 'Partial payment recorded'
            : 'Order payment confirmed',
        };
      }
    }
  }

  private sepayDeps() {
    return {
      prisma: this.prisma,
      notifications: this.notifications,
      invoices: this.invoices,
      logger: this.logger,
    };
  }

  async assertCustomerExists(tenantId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, tenantId, isDeleted: false },
      select: { id: true },
    });
    if (!customer)
      throw new NotFoundException({
        code: ErrorCode.CUSTOMER_NOT_FOUND,
        message: 'Customer not found',
      });
  }

  /** Khách vãng lai của tenant, tạo ở lần dùng đầu. */
  async resolveWalkInCustomer(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const customer = await tx.customer.upsert({
      where: {
        tenantId_customerCode: {
          tenantId,
          customerCode: WALK_IN_CUSTOMER_CODE,
        },
      },
      create: {
        tenantId,
        customerCode: WALK_IN_CUSTOMER_CODE,
        name: WALK_IN_CUSTOMER_NAME,
        gender: 'OTHER',
        isDeleted: false,
      },
      update: {},
      select: { id: true },
    });
    return customer.id;
  }

  /** Báo màn hình cửa hàng đơn vừa được thanh toán. */
  private announcePaid(
    order: { id: string; tenantId: string; status: string },
    paidAmount: number,
    paymentMethod: string,
    extra: { partial: boolean; due: number; paymentStatus: string },
  ) {
    this.realtime.emitToRoom(`tenant:${order.tenantId}`, 'order:paid', {
      orderId: order.id,
      status: order.status,
      paidAmount,
      paymentMethod,
      partial: extra.partial,
      due: extra.due,
      paymentStatus: extra.paymentStatus,
    });
  }

  /** Lấy đơn và kiểm quyền đọc/ghi theo chi nhánh. */
  private async findRow(
    user: AuthUser,
    tenantId: string,
    id: string,
  ): Promise<OrderRow> {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });

    const scope = this.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    return order;
  }

  /** Chuyển Decimal thành number vì quầy tính toán trên chúng. */
  private toResponse(order: OrderRow) {
    const {
      grandTotal,
      customerPay,
      change,
      discountValue,
      items,
      payments,
      ...rest
    } = order;
    return {
      ...rest,
      payments: payments.map((payment) => ({
        ...payment,
        amount: Number(payment.amount),
        requestedAmount:
          payment.requestedAmount === null
            ? null
            : Number(payment.requestedAmount),
      })),
      branch: namedBranch(rest.branch),
      grandTotal: Number(grandTotal),
      customerPay: customerPay === null ? null : Number(customerPay),
      change: change === null ? null : Number(change),
      discountValue: Number(discountValue),
      items: items.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        discountAmount: Number(item.discountAmount),
      })),
      appliedPromotions: order.appliedPromotions.map((promotion) => ({
        ...promotion,
        discountAmount:
          promotion.discountAmount === null
            ? null
            : Number(promotion.discountAmount),
      })),
    };
  }
}
