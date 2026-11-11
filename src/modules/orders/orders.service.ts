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

const WALK_IN_CUSTOMER_CODE = 'KH_VANGLAI';
const WALK_IN_CUSTOMER_NAME = 'Khách vãng lai';

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

/** Bản port của OrderService. Bán hàng đổi tiền và tồn kho ngay, nên mỗi hàm tính số, ghi trong một transaction rồi mới báo người. Tổng tiền do server tính, không nhận từ client; giảm giá cũng vậy: client chỉ nêu khuyến mãi, `OrderPricingService.priceOrder` chạy qua cùng engine của `/promotions/calculate`. */
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

  /** Bán tại quầy (`POST /orders/pos`): thu và trừ kho ngay, nằm ngoài hành trình đơn. Tạo đơn tay của hành trình là `ManualOrderService.create` (`POST /orders`). */
  async createPosSale(
    user: AuthUser,
    tenantId: string,
    dto: CreatePosOrderDto,
  ) {
    const userId = user.userId;
    // Ghi đơn phải có phạm vi giống lúc đọc: trước đây `create` không nhận người gọi nên thu ngân có thể lên đơn cho chi nhánh khác, trừ tồn và sổ của chi nhánh đó, rồi không thấy đơn để hoàn tác.
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

    // Combo trong giỏ tính giá như một bộ nhưng không có tồn riêng: được mở thành các dòng thực tế (lá đã phẳng hoá), và chính các lá này rời kho bên dưới. Làm trước transaction vì mở combo cần đọc danh mục.
    const components = await expandCombos(this.prisma, tenantId, lines);
    // Quầy trừ kho ngay tại chi nhánh và chưa bao giờ lưu kho xuất hay thuế VAT trên dòng; hai trường này để trống để combo không làm đổi cách lưu hay xuất hóa đơn các dòng khác của đơn quầy.
    const itemRows = buildOrderItemRows(
      lines.map((line) => ({ ...line, sourceLocationId: null })),
      components,
      (line) => this.pricing.lineTotalOf(line),
    ).map((row) => ({ ...row, vatRate: undefined }));

    // Tiền khách đưa phải ít nhất đủ trả hóa đơn, để chênh lệch là "tiền thừa" chứ không phải thiếu âm thầm bị ghi thành doanh thu.
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
          // Đơn quầy được xác nhận và xử lý bởi người lên đơn; ràng buộc `orders_assignee_required` yêu cầu mọi đơn không phải nháp có người phụ trách. Đơn tay của hành trình chỉ định người phụ trách rõ ràng (`ManualOrderService`).
          assigneeId: userId,
          confirmedById: userId,
          confirmedAt: now,
          fulfillmentType: FulfillmentType.TAKEAWAY,
          status,
          // Đơn quầy mở ở COMPLETED (thu ngay) thì chốt luôn lúc này: CHECK `orders_completed_at_required`.
          ...(status === OrderStatus.COMPLETED ? { completedAt: now } : {}),
          // paymentStatus để mặc định UNPAID: khoản tiền ghi bên dưới rồi `syncOrderPaymentStatus` suy ra trạng thái (đơn quầy giờ cũng có Payment).
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

      // Bán làm giảm tồn nên theo dõi ngưỡng tồn thấp giống như chuyển kho; `deductStock` cũng là chỗ kiểm "đủ hàng không" mà không có race giữa kiểm tra và trừ.
      const lowStock: (Inventory | null)[] = [];
      // Chỉ dòng có hàng mới rời kệ: dòng COMBO cha chỉ là giá, SERVICE không có gì để lấy, nên các con của combo bị trừ còn cha thì không. Mỗi dòng sổ ghi tên dòng đơn của nó (không phải SKU: một SKU giờ có thể vừa nằm dòng riêng vừa nằm trong combo), để biết giá vốn của dòng.
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

      // Tiền: nhận ngay thì một khoản FULL (+ CHANGE nếu thối) và dòng thu chi của chúng; SePay thì khoản FULL chờ webhook, hạn QR = lúc tạo đơn + 15 phút.
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

      // Đơn quầy có hóa đơn ngay từ đầu: phát hành luôn nếu đã trả, PENDING trong khi chờ chuyển khoản SePay (webhook sẽ phát hành).
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

    // Mã QR chỉ phát qua `sepayQrView` (cửa duy nhất): hạn của đơn quầy là lúc tạo đơn + 15 phút, FE đếm ngược theo `qrExpiresAt`.
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
    // Chỉ thu hẹp, không thay thế: `findOne` đã từ chối chi nhánh lạ, nên việc danh sách bị đổi phạm vi qua query string mới là chỗ bất thường.
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

  /** Tài khoản này xem được đơn của chi nhánh nào: mặc định của mình, có `orders:view_all` thì mọi chi nhánh. iKiotMS-BE cũ không phân phạm vi này, quyền nằm trong danh mục mà không dùng; cách làm giống `stock-movements`. */
  /** Tài khoản này đọc/ghi được đơn của chi nhánh nào: của mình, hoặc mọi chi nhánh với `orders:view_all`. Dùng chung với `ManualOrderService` để hai bên tạo đơn từ chối chi nhánh khác theo cùng quy tắc. */
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

  /** Chuyển đơn sang trạng thái mới, đưa tồn kho và tiền về đúng theo trạng thái đó. Lệnh ghi có điều kiện theo status đã đọc, nên hai quầy bấm cùng lúc không thể cùng áp dụng hiệu ứng phụ. */
  async updateStatus(
    user: AuthUser,
    tenantId: string,
    id: string,
    newStatus: string,
  ) {
    const order = await this.findRow(user, tenantId, id);

    // Đơn quầy chờ SePay không được chốt COMPLETED bằng PATCH: không có khoản nào về mà vẫn ghi doanh thu và dòng tiền "SePay" (tiền ma). Muốn chốt thì `pay-offline` (thu tay, có số tiền) hoặc đợi webhook.
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

    // Chỉ máy trạng thái của quầy: đơn hành trình chuyển sang RETURNED ở đây sẽ trả mọi dòng về chi nhánh và bỏ qua `order-returns` hoàn toàn. Đơn hành trình chuyển qua route riêng (`assertTransition`).
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

    // Huỷ đơn quầy đang chờ QR đi chung một hàm với nút "Hủy đơn này" và cron QR hết hạn: một nơi trả hàng về kho, huỷ hoá đơn nháp và ghi sự kiện CANCELLED.
    // PATCH không có số hoàn: đơn đã có tiền (khách chuyển thiếu) phải huỷ bằng `POST /orders/pos/:id/cancel` kèm `refundAmount` (người gọi PATCH nhận `ORDER_REFUND_AMOUNT_REQUIRED`).
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

      // Trả hàng đơn quầy luôn hoàn đúng số tiền đang giữ (quyết định 2026-11-11, D4): khoản REFUND + dòng chi ORDER_REFUND, rồi trạng thái thanh toán suy ra (hoàn hết → REFUNDED). Người bấm trả hàng là người hoàn tiền.
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

      // Cố ý không theo dõi tồn thấp ở đây: hủy và trả chỉ làm tồn tăng, mà tồn tăng thì không thể rơi xuống dưới ngưỡng.
      if (
        newStatus === OrderStatus.CANCELLED ||
        newStatus === OrderStatus.RETURNED
      ) {
        // Trả về đúng các lô mà đơn đã lấy. Đơn lên trước khi có lô (2026-10-02) không có dòng sổ để theo, nên trả về thành lô OPENING.
        // Chỉ dòng đã lấy hàng mới được trả hàng. Combo cha chưa bao giờ lấy gì; nếu không lọc, `ifNeverDrawn` sẽ mở một lô cho SKU của combo, tức tồn cho một biến thể không được phép có tồn.
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

  /**
   * Huỷ một đơn quầy đang chờ QR, trong transaction của người gọi. Có điều kiện (còn PENDING + SEPAY): thu ngân bấm, cron hết hạn và webhook thắng cùng lúc thì chỉ một bên áp dụng hiệu ứng phụ.
   * Khoá đơn trước (thứ tự khoá sổ → đơn → khoản: webhook đang chờ khoá sau dòng sổ của nó sẽ thấy đơn đã huỷ rồi từ chối). Các khoản QR còn mở bị huỷ cùng đơn.
   * `allowPaid` false (cron QR hết hạn): đơn đã có khoản PAID (khách chuyển thiếu) thì không tự huỷ, vì huỷ phải quyết định hoàn hay giữ tiền. `allowPaid` true (người bấm): đơn đang giữ tiền thì bắt buộc nêu số hoàn (`resolveRefund`), hoàn là khoản REFUND + dòng chi.
   * Trả `false` khi đơn không còn chờ nữa. Sự kiện CANCELLED chỉ ghi sau khi chiếm được đơn.
   */
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
    // Tiền shop giữ lại sau khi hoàn (khách chuyển thiếu rồi không lấy hàng, hoàn ít hơn đã nhận) là thu nhập khác.
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

    // Trả về đúng các lô mà đơn đã lấy (đơn quầy trừ kho ngay lúc tạo). Chỉ dòng đã lấy hàng mới được trả: combo cha chưa bao giờ lấy gì.
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

  /**
   * "Hủy đơn này" trên màn QR của quầy (`POST /orders/pos/:id/cancel`). Người chỉ có `orders:create` (thu ngân) huỷ được đơn do chính mình lên; huỷ đơn của người khác cần `orders:update`.
   * Khác `PATCH /orders/:id/status` ở chỗ không đòi `orders:update` cho đơn của mình, nhận số hoàn cho đơn đã có tiền (`refundAmount`, `refundMethod`), và chỉ áp dụng cho đơn quầy đang chờ QR.
   */
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

  /**
   * Cron QR hết hạn: huỷ các đơn quầy chờ QR đã quá 15 phút và CHƯA có đồng nào, trả hàng về kho. Mỗi đơn một transaction để một đơn lỗi không kéo cả lượt; nguồn sự kiện là SYSTEM.
   * Đơn đã có khoản PAID (khách chuyển thiếu) không bao giờ bị cron huỷ: số tiền đó thuộc về khách, huỷ hay thu nốt là việc của người ở quầy. Hạn của đơn là hạn của MỌI khoản QR còn mở của nó (mã mới phát cho phần còn lại kéo dài hạn); đơn cũ chưa có Payment tính từ `createdAt`.
   * Lọc thô theo `createdAt` trong SQL rồi lọc đúng bằng `isQrExpired`. Trả số đơn đã huỷ.
   */
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
      } catch (error) {
        this.logger.error(
          `Failed to cancel expired QR order ${order.code}`,
          error instanceof Error ? error.stack : error,
        );
      }
    }
    return cancelled;
  }

  /** Báo màn hình cửa hàng biết đơn quầy vừa bị huỷ (tay hay do QR hết hạn) để màn QR đang mở chuyển sang "đã huỷ". */
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

  /**
   * Chốt đơn quầy chờ SePay bằng cách khác (khách trả tiền mặt / chuyển khoản tay). Khoá đơn rồi huỷ các khoản QR còn mở, tính số còn phải thu từ các khoản đã nhận (khách chuyển thiếu trước đó thì chỉ thu phần còn lại),
   * ghi khoản FULL (hay BALANCE nếu đã có tiền) + CHANGE nếu thối tiền, đơn COMPLETED khi đủ tiền. Có điều kiện: đơn vẫn PENDING và vẫn SEPAY, để không chạy đua với webhook làm thu hai lần.
   */
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
      // Mã QR đang chờ không còn dùng (khách đã trả bằng cách khác): huỷ, ghi ai huỷ. Tiền vừa về thì webhook đã giữ khoá trước nên tới đây khoản đã PAID, không nằm trong danh sách mở.
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

      // Khoản tiền + dòng thu chi + trạng thái thanh toán (đủ tiền nên ra PAID) trong cùng transaction với việc chiếm đơn.
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

  /**
   * Phát mã QR cho phần còn lại của đơn quầy chờ SePay (`POST /orders/pos/:id/qr`): khách chuyển thiếu rồi muốn chuyển nốt (hay mã cũ hết hạn mà đơn chưa bị huỷ). Số tiền = số còn phải thu của đơn, mã tham chiếu mới, hạn mới.
   * Khoá đơn; còn một mã đang sống đúng số tiền thì trả nguyên mã đó (bấm hai lần không đổi mã khách đang quét), ngược lại huỷ các mã còn mở rồi tạo khoản mới (FULL nếu chưa có đồng nào, BALANCE nếu đã trả một phần).
   * Người chỉ có `orders:create` chỉ làm được trên đơn của chính mình (cùng quy tắc với huỷ).
   */
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

  /**
   * Phần webhook SePay xử lý khi tiền về cho đơn quầy, nhận các tham số rời (test và tích hợp gọi trực tiếp). Webhook thật gọi `completeSepayTransfer` với giao dịch đã chuẩn hoá. Chi tiết ở đó.
   */
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

  /**
   * Phần webhook SePay xử lý khi tiền về cho đơn quầy. Trả `null` khi mã không thuộc đơn quầy nào (webhook thử tiếp khoản thu khi giao), `{ message }` khi đã xử lý (chốt, chốt thiếu, trùng, hoặc từ chối và báo chủ shop).
   * Toàn bộ chốt tiền nằm ở `processSepayTransfer` (`sepay-settlement.ts`), dùng chung với thu khi giao. Hết hạn tính TRƯỚC: đơn vẫn chờ thì chốt dù QR đã hết hạn (tiền về thật), đơn đã huỷ / đã thu thì từ chối + ghi sổ + báo chủ shop hoàn.
   * Chuyển thiếu là khoản trả một phần: đơn vẫn PENDING, thu ngân nhận thông báo và chọn QR cho phần còn lại hay thu tiền mặt.
   */
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
        // Đáng gửi thông báo thật, khác các bước còn lại của hành trình: xác nhận đến sau vài phút, lúc thu ngân không còn nhìn màn hình đó nữa.
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

  /** Đơn không gắn khách vẫn cần một dòng khách, nên mỗi tenant có một khách vãng lai, tạo ở lần dùng đầu. Dùng `upsert` vì hai đơn ẩn danh cùng lúc sẽ cùng không thấy gì và cùng insert. */
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

  /** Báo cho màn hình cửa hàng biết đơn vừa được thanh toán. Room `order:<id>` cũ đã bỏ vì gateway chỉ đưa socket vào room do server chọn, nên gửi vào room tenant với mã đơn trong payload. `partial` / `due` / `paymentStatus` cho màn QR biết khách chuyển thiếu (đơn chưa hoàn thành, còn `due`). */
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

  /** Lấy một đơn và kiểm tra tài khoản này được đọc hay ghi nó không. Kiểm tra chi nhánh từng chỉ nằm trong `findOne`, nên một tài khoản có thể RETURN đơn mình không được xem, trả tồn về chi nhánh đó và ghi hoàn tiền vào sổ của nó. */
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
