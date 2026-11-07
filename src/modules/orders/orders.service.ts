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
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { PaymentMethod } from '../../common/constants/payment-method';
import {
  FulfillmentType,
  STOCKED_LINE_TYPES,
  OrderPaymentStatus,
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
import { buildSepayQrUrl, requireTenantBanking } from './tenant-banking';
import { OrderPricingService } from './order-pricing.service';
import { buildOrderItemRows, expandCombos } from './order-combo';
import {
  INSTANT_COMPLETE_METHODS,
  OrderStatus,
  VALID_ORDER_TRANSITIONS,
} from './order.constants';
import {
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
    if (dto.customerPay !== undefined && dto.customerPay < grandTotal) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_CUSTOMER_PAY_TOO_LOW,
        message: `The customer paid ${dto.customerPay}, which is less than the ${grandTotal} due`,
      });
    }
    const change =
      dto.customerPay === undefined
        ? null
        : Math.max(0, dto.customerPay - grandTotal);

    const status = INSTANT_COMPLETE_METHODS.includes(dto.paymentMethod)
      ? OrderStatus.COMPLETED
      : OrderStatus.PENDING;
    const paymentReference = this.sepay.generateOrderReference();

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
          confirmedAt: new Date(),
          fulfillmentType: FulfillmentType.TAKEAWAY,
          status,
          paymentStatus:
            status === OrderStatus.COMPLETED
              ? OrderPaymentStatus.PAID
              : OrderPaymentStatus.UNPAID,
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

      if (status === OrderStatus.COMPLETED) {
        await this.writeSaleCashFlows(tx, created, dto.paymentMethod, userId);
      }

      // Đơn quầy có hóa đơn ngay từ đầu: phát hành luôn nếu đã trả, PENDING trong khi chờ chuyển khoản SePay (webhook sẽ phát hành).
      await this.invoices.ensurePending(tx, created.id);
      if (status === OrderStatus.COMPLETED) {
        await this.invoices.issueForOrder(tx, created.id, userId);
      }

      return { order: created, crossings: lowStock };
    });

    await this.inventory.notifyLowStock(crossings);

    return {
      order: this.toResponse(order),
      qrUrl:
        isSepay && banking
          ? buildSepayQrUrl(banking, grandTotal, paymentReference)
          : null,
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

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id, status: order.status },
        data: {
          status: newStatus,
          ...(newStatus === OrderStatus.COMPLETED
            ? { paymentStatus: OrderPaymentStatus.PAID }
            : newStatus === OrderStatus.RETURNED
              ? { paymentStatus: OrderPaymentStatus.REFUNDED }
              : {}),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }

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

      if (newStatus === OrderStatus.COMPLETED) {
        await this.writeSaleCashFlows(
          tx,
          order,
          order.paymentMethod,
          order.userId,
        );
        await this.invoices.issueForOrder(tx, order.id, user.userId);
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
      }

      if (newStatus === OrderStatus.RETURNED) {
        await tx.cashFlow.create({
          data: {
            tenantId,
            // Id chi nhánh của đơn cũng là id Location, là nơi sổ ghi nhận.
            locationId: order.branchId,
            orderId: order.id,
            createdById: order.userId,
            flowType: 'EXPENSE',
            amount: order.grandTotal,
            paymentMethod: order.paymentMethod,
            paymentReference: order.paymentReference,
            description: `Trả hàng đơn ${order.paymentReference}`,
          },
        });
      }

      return tx.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_INCLUDE,
      });
    });

    return this.toResponse(updated);
  }

  /** Chốt đơn SePay đã trả bằng cách khác. Có điều kiện: đơn vẫn PENDING và vẫn SEPAY, để không chạy đua với webhook làm thu hai lần. */
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

    const grandTotal = Number(order.grandTotal);
    const customerPay = dto.customerPay ?? grandTotal;
    if (customerPay < grandTotal) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_CUSTOMER_PAY_TOO_LOW,
        message: `The customer paid ${customerPay}, which is less than the ${grandTotal} due`,
      });
    }
    const paymentMethod = dto.paymentMethod ?? PaymentMethod.CASH;

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id,
          status: OrderStatus.PENDING,
          paymentMethod: PaymentMethod.SEPAY,
        },
        data: {
          status: OrderStatus.COMPLETED,
          paymentStatus: OrderPaymentStatus.PAID,
          paymentMethod,
          customerPay,
          change: Math.max(0, customerPay - grandTotal),
          ...(dto.note ? { note: dto.note } : {}),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_PAYMENT_CONFLICT,
          message: 'This order has just been paid or cancelled, please reload',
        });
      }

      const settled = await tx.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_INCLUDE,
      });
      await this.writeSaleCashFlows(tx, settled, paymentMethod, userId);
      await this.invoices.issueForOrder(tx, settled.id, userId);
      return settled;
    });

    this.announcePaid(updated, grandTotal, paymentMethod);
    return this.toResponse(updated);
  }

  /** Phần webhook SePay xử lý khi tiền về. Trả `null` thay vì ném lỗi khi không có gì để chốt, để controller trả 200 và SePay thôi retry; đơn đã chốt rồi thì ghi log to vì phải có người hoàn tiền bằng tay. */
  async completeSepayOrder(
    tenantId: string,
    paymentReference: string,
    sepayTransactionId: string | null,
    transferAmount: number,
  ) {
    const pending = await this.prisma.order.findFirst({
      where: {
        tenantId,
        paymentReference,
        status: OrderStatus.PENDING,
        paymentMethod: PaymentMethod.SEPAY,
      },
      select: { id: true, grandTotal: true },
    });

    if (!pending) {
      const settled = await this.prisma.order.findFirst({
        where: { tenantId, paymentReference },
        select: { id: true, status: true, paymentMethod: true },
      });
      if (settled) {
        this.logger.warn(
          `SePay transfer ${sepayTransactionId ?? '(no id)'} (${transferAmount}) for ${paymentReference} ignored - ` +
            `order ${settled.id} is already ${settled.status} via ${settled.paymentMethod}. Manual refund may be required.`,
        );
      }
      return null;
    }

    const grandTotal = Number(pending.grandTotal);
    if (transferAmount < grandTotal) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_TRANSFER_AMOUNT_SHORT,
        message: `Transfer is short: ${grandTotal} due, ${transferAmount} received`,
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: pending.id, status: OrderStatus.PENDING },
        data: {
          status: OrderStatus.COMPLETED,
          paymentStatus: OrderPaymentStatus.PAID,
          sepayTransactionId,
        },
      });
      if (claimed.count === 0) return null;

      const settled = await tx.order.findUniqueOrThrow({
        where: { id: pending.id },
        include: ORDER_INCLUDE,
      });
      await tx.cashFlow.create({
        data: {
          tenantId: settled.tenantId,
          locationId: settled.branchId,
          orderId: settled.id,
          createdById: settled.userId,
          flowType: 'INCOME',
          amount: transferAmount,
          paymentMethod: PaymentMethod.SEPAY,
          paymentReference: settled.paymentReference,
          // Lưu ở cả hai dòng như iKiotMS-BE cũ: đơn trả lời "đã trả chưa", còn dòng dòng tiền là thứ đối soát với sao kê ngân hàng đọc.
          sepayTransactionId,
          description: `SePay - ${settled.paymentReference}`,
        },
      });
      await this.invoices.issueForOrder(tx, settled.id, settled.userId);
      return settled;
    });

    if (!updated) return null;

    this.announcePaid(updated, transferAmount, PaymentMethod.SEPAY);

    // Đáng gửi thông báo thật, khác các bước còn lại của hành trình: xác nhận đến sau vài phút, lúc thu ngân không còn nhìn màn hình đó nữa.
    const managers = await this.notifications.managersOfLocation({
      tenantId: updated.tenantId,
      locationId: updated.branchId,
    });
    await this.notifications.notify({
      tenantId: updated.tenantId,
      recipientIds: [updated.userId, ...managers],
      referenceId: updated.id,
      ...OrderNotificationTemplates.paid(
        updated.paymentReference ?? '',
        transferAmount,
      ),
    });

    return this.toResponse(updated);
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

  /** Các dòng tiền của đơn hoàn tất. Bán tiền mặt có thối là hai dòng, vì ngăn kéo thật sự nhận đủ tờ tiền rồi trả lại một phần; chỉ dòng thu có `orderId`, để `@@unique([orderId, flowType])` vẫn đúng khi RETURN ghi dòng EXPENSE riêng. */
  private async writeSaleCashFlows(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      tenantId: string;
      branchId: string;
      grandTotal: Prisma.Decimal;
      customerPay: Prisma.Decimal | null;
      change: Prisma.Decimal | null;
      paymentReference: string | null;
    },
    paymentMethod: string | null,
    // Null với đơn đồng bộ từ kênh bán hàng, vì không ai ở quầy tạo nó.
    createdById: string | null,
  ) {
    const change = Number(order.change ?? 0);
    const givesChange =
      paymentMethod === PaymentMethod.CASH &&
      change > 0 &&
      order.customerPay !== null;

    await tx.cashFlow.create({
      data: {
        tenantId: order.tenantId,
        locationId: order.branchId,
        orderId: order.id,
        createdById,
        flowType: 'INCOME',
        amount: givesChange ? order.customerPay! : order.grandTotal,
        paymentMethod,
        paymentReference: order.paymentReference,
        description: `Đơn hàng ${order.paymentReference}`,
      },
    });

    if (givesChange) {
      await tx.cashFlow.create({
        data: {
          tenantId: order.tenantId,
          locationId: order.branchId,
          createdById,
          flowType: 'EXPENSE',
          amount: change,
          paymentMethod,
          paymentReference: order.paymentReference,
          description: `Tiền thối cho đơn ${order.paymentReference}`,
        },
      });
    }
  }

  /** Báo cho màn hình cửa hàng biết đơn vừa được thanh toán. Room `order:<id>` cũ đã bỏ vì gateway chỉ đưa socket vào room do server chọn, nên gửi vào room tenant với mã đơn trong payload. */
  private announcePaid(
    order: { id: string; tenantId: string; status: string },
    paidAmount: number,
    paymentMethod: string,
  ) {
    this.realtime.emitToRoom(`tenant:${order.tenantId}`, 'order:paid', {
      orderId: order.id,
      status: order.status,
      paidAmount,
      paymentMethod,
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
    const { grandTotal, customerPay, change, discountValue, items, ...rest } =
      order;
    return {
      ...rest,
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
