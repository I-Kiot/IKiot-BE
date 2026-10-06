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
import { FulfillmentType } from '../../common/constants/order-status';
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
import { ErrorCode } from '../../common/errors/error-codes';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';

/** The one customer every tenant gets for free, for sales with nobody attached. */
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

/** Real port of OrderService. Selling moves money and stock at once, so every method here works out the numbers, writes them in one transaction, and only then tells a human. The total is computed, never accepted - the old API stored the client's `grandTotal` - and so is the discount: the client names its promotions and `OrderPricingService.priceOrder` runs them through the same engine `/promotions/calculate` uses. */
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
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────────

  /** A till sale (`POST /orders/pos`): paid and deducted on the spot, outside the order journey. The journey's own manual create is `ManualOrderService.create` (`POST /orders`). */
  async createPosSale(
    user: AuthUser,
    tenantId: string,
    dto: CreatePosOrderDto,
  ) {
    const userId = user.userId;
    // Writing a sale is scoped exactly like reading one: `create` never received the caller, so a cashier could book an order against another branch - drawing down that branch's stock and ledger, and unable to see the row afterwards to undo it.
    const scope = this.branchScope(user);
    if (scope.branchId !== undefined && dto.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'You can only create orders for your own branch',
      });
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
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

    // Cash tendered has to at least cover the bill - the difference between "change" and a silent shortfall booked as revenue.
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
      // Resolved inside the transaction: a walk-in row created for an order that then fails would otherwise be left behind.
      const customerId =
        dto.customerId ?? (await this.resolveWalkInCustomer(tx, tenantId));

      const created = await tx.order.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          customerId,
          userId,
          // A till sale is confirmed and handled by whoever rings it up - the orders_assignee_required CHECK needs a person in charge on every non-draft order. The journey's manual orders name theirs explicitly (`ManualOrderService`).
          assigneeId: userId,
          confirmedById: userId,
          confirmedAt: new Date(),
          fulfillmentType: FulfillmentType.TAKEAWAY,
          status,
          // The till's reference doubles as its order code, so a receipt and a bank transfer name the sale the same way.
          code: paymentReference,
          paymentMethod: dto.paymentMethod,
          paymentReference,
          grandTotal,
          customerPay: dto.customerPay,
          change,
          note: dto.note,
          discountType,
          discountValue,
          items: {
            create: lines.map((line) => ({
              productItemId: line.productItemId,
              productName: line.productName,
              sku: line.sku,
              quantity: line.quantity,
              listUnitPrice: line.listUnitPrice,
              unitPrice: line.unitPrice,
              discountAmount: line.discountAmount,
              lineTotal: this.pricing.lineTotalOf(line),
            })),
          },
          appliedPromotions: { create: appliedPromotions },
        },
        include: ORDER_INCLUDE,
      });

      // Selling takes stock off the shelf, so it watches the low-stock threshold exactly like a transfer does, and `deductStock` is also what enforces "is there enough" without a check-then-decrement race.
      const lowStock: (Inventory | null)[] = [];
      // Each ledger row names its order line, so the line's cost of goods sold is known. Lines are matched back by SKU, in order - two lines of one SKU are interchangeable.
      const createdLines = new Map<string, string[]>();
      for (const item of created.items) {
        createdLines.set(item.productItemId, [
          ...(createdLines.get(item.productItemId) ?? []),
          item.id,
        ]);
      }
      for (const line of lines) {
        const after = await this.inventory.deductStock(tx, {
          tenantId,
          productItemId: line.productItemId,
          locationId: dto.branchId, // a Branch's id is its Location's id
          quantity: line.quantity,
          label: line.sku ?? line.productItemId,
          ledger: {
            type: InventoryTxType.SALE,
            referenceType: InventoryRefType.ORDER,
            referenceId: created.id,
            createdById: userId,
            orderItemId: createdLines.get(line.productItemId)?.shift() ?? null,
          },
        });
        lowStock.push(this.inventory.lowStockCrossing(after, -line.quantity));
      }

      if (status === OrderStatus.COMPLETED) {
        await this.writeSaleCashFlows(tx, created, dto.paymentMethod, userId);
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

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async findAll(user: AuthUser, tenantId: string, query: QueryOrderDto) {
    const scope = this.branchScope(user);
    const where: Prisma.OrderWhereInput = { tenantId, ...scope };
    if (query.status) where.status = query.status;
    if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
    // Narrows, never replaces - `findOne` already refused a foreign branch, so the list endpoint being redirected by a query string was the outlier.
    const branchId = narrowToScope(
      scope.branchId,
      query.branchId,
      'You can only view orders for your own branch',
    );
    if (branchId) where.branchId = branchId;

    // A named customer wins over a free-text search, as in the old service: asking for both means the id is the specific thing.
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

  /** Which branches this account may see sales from: its own by default, everything with `orders:view_all`. iKiotMS-BE didn't scope this at all, and the permission has sat in the catalog unused - the same shape `stock-movements` already uses. */
  /** Which branch's orders this account may read or write: its own, or every one with `orders:view_all`. Shared with `ManualOrderService`, so both creates refuse another branch by the same rule. */
  branchScope(user: AuthUser): { branchId?: string } {
    if (can(user, 'orders', 'view_all')) return {};
    if (!user.branchId) {
      // Not posted anywhere, and no view_all: no branch's sales are theirs to read.
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }
    return { branchId: user.branchId };
  }

  // ─── Status ────────────────────────────────────────────────────────────────

  /** Moves an order along its lifecycle, putting stock and money where the new state says they should be. The status write is conditional on the status we read, so two tills pressing the button at once can't both apply their side effects. */
  async updateStatus(
    user: AuthUser,
    tenantId: string,
    id: string,
    newStatus: string,
  ) {
    const order = await this.findRow(user, tenantId, id);

    // The till's state machine only: an order-journey order moving to RETURNED here would put every line back at the branch and skip `order-returns` entirely. Journey orders move through their own routes (`assertTransition`).
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
        data: { status: newStatus },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order status has just changed, please reload',
        });
      }

      // No low-stock watch here on purpose: cancelling and returning only put stock back, and a rising level can't cross the threshold downwards.
      if (
        newStatus === OrderStatus.CANCELLED ||
        newStatus === OrderStatus.RETURNED
      ) {
        // Back into the lots the sale drew from. A sale rung up before lots existed (2026-10-02) has no ledger rows to follow and comes back as an OPENING lot.
        for (const line of order.items) {
          await this.inventory.returnDrawn(tx, {
            tenantId,
            productItemId: line.productItemId,
            toLocationId: order.branchId, // a Branch's id is its Location's id
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
      }

      if (newStatus === OrderStatus.RETURNED) {
        await tx.cashFlow.create({
          data: {
            tenantId,
            // The order's branch id is its Location id - what the ledger books against.
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

  /** Settles a SePay order paid another way, conditional on it still being PENDING and still SEPAY so it can't race the webhook into charging twice. */
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
      return settled;
    });

    this.announcePaid(updated, grandTotal, paymentMethod);
    return this.toResponse(updated);
  }

  /** The SePay webhook's side of a transfer landing. Returns `null` rather than throwing when there is nothing to settle, so the controller can answer 200 and stop the retries; an already-settled order is logged loudly, because somebody has to refund by hand. */
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
        data: { status: OrderStatus.COMPLETED, sepayTransactionId },
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
          // Stored on both rows, as iKiotMS-BE did: the order answers "was this paid", the cash flow is what a reconciliation against the bank statement reads.
          sepayTransactionId,
          description: `SePay - ${settled.paymentReference}`,
        },
      });
      return settled;
    });

    if (!updated) return null;

    this.announcePaid(updated, transferAmount, PaymentMethod.SEPAY);

    // Worth a real notification, unlike the rest of the order flow: the confirmation arrives minutes later, when the cashier is no longer watching that screen.
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

  // ─── Internals ─────────────────────────────────────────────────────────────

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

  /** A sale with nobody attached still needs a customer row, so each tenant gets one walk-in record created on first use - an `upsert`, since two anonymous sales at once would both find nothing and both insert. */
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

  /** The money rows for a completed sale. A cash sale with change is two rows, since the drawer really took the full note and handed some back; only the income row carries `orderId`, so `@@unique([orderId, flowType])` still holds when a RETURN writes its own EXPENSE row. */
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
    // Null for an order synced from a sales channel - nobody at the till created it.
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

  /** Tells the shop floor an order just got paid. The old `order:<id>` room is gone - the gateway only puts sockets in rooms the server chose - so this goes to the tenant room with the order id in the payload. */
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

  /** One order, and the check that this account may touch it - read or write. The branch check used to live in `findOne` alone, so an account could RETURN an order it wasn't allowed to see, crediting that branch's stock back and posting a refund to its ledger. */
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

  /** Decimals become numbers - the till does arithmetic on them. */
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
