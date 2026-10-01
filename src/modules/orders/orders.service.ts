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
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';
import { paginate, skipFor } from '../../common/utils/pagination';
import { narrowToScope } from '../../common/utils/scope-filter';
import { SepayOrderService } from './sepay-order.service';
import { PromotionService } from '../promotions/promotions.service';
import {
  INSTANT_COMPLETE_METHODS,
  OrderStatus,
  VALID_ORDER_TRANSITIONS,
} from './order.constants';
import {
  CreateOrderDto,
  PayOfflineOrderDto,
  QueryOrderDto,
} from './dto/order.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

/** The one customer every tenant gets for free, for sales with nobody attached. */
const WALK_IN_CUSTOMER_CODE = 'KH_VANGLAI';
const WALK_IN_CUSTOMER_NAME = 'Khách vãng lai';

const ORDER_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  branch: { select: { id: true, name: true } },
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

/** Real port of OrderService. Selling moves money and stock at once, so every method here works out the numbers, writes them in one transaction, and only then tells a human. The total is computed, never accepted - the old API stored the client's `grandTotal` - and so is the discount: the client names its promotions and `priceOrder` runs them through the same engine `/promotions/calculate` uses. */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
    private readonly realtime: RealtimeGateway,
    private readonly sepay: SepayOrderService,
    private readonly promotions: PromotionService,
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(user: AuthUser, tenantId: string, dto: CreateOrderDto) {
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
    const banking = isSepay ? await this.requireBanking(tenantId) : null;

    const priced = await this.priceOrder(tenantId, dto);
    const { lines, appliedPromotions, discountType, discountValue } = priced;
    const grandTotal = this.grandTotalOf(lines, discountType, discountValue);

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
          status,
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
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discountAmount: line.discountAmount,
            })),
          },
          appliedPromotions: { create: appliedPromotions },
        },
        include: ORDER_INCLUDE,
      });

      // Selling takes stock off the shelf, so it watches the low-stock threshold exactly like a transfer does, and `deductStock` is also what enforces "is there enough" without a check-then-decrement race.
      const lowStock: (Inventory | null)[] = [];
      for (const line of lines) {
        const after = await this.inventory.deductStock(tx, {
          tenantId,
          productItemId: line.productItemId,
          branchId: dto.branchId,
          warehouseId: null,
          quantity: line.quantity,
          label: line.sku ?? line.productItemId,
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
          ? this.sepay.buildQrUrl(banking, grandTotal, paymentReference)
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
  private branchScope(user: AuthUser): { branchId?: string } {
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

    const allowed = VALID_ORDER_TRANSITIONS[order.status] ?? [];
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
        for (const line of order.items) {
          await this.inventory.adjustStock(tx, {
            tenantId,
            productItemId: line.productItemId,
            branchId: order.branchId,
            warehouseId: null,
            delta: Number(line.quantity),
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
            branchId: order.branchId,
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
          branchId: settled.branchId,
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
      branchId: updated.branchId,
      warehouseId: null,
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

  private async assertCustomerExists(tenantId: string, customerId: string) {
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

  /** Everything about the sale's money, worked out here rather than taken on trust. The promotion discount is priced server-side through the same engine `/promotions/calculate` runs - it used to be assumed the client had echoed a breakdown back, so a till that sent only a total got a full-price order and no error - and the engine re-checks eligibility, so an expired or out-of-branch promotion is a 400 instead of a discount. The variants are looked up twice on a promotion sale; one extra indexed read is the price of the engine owning its own view of the cart. */
  private async priceOrder(tenantId: string, dto: CreateOrderDto) {
    const lines = await this.priceLines(tenantId, dto);
    const promotionIds = [
      ...new Set((dto.appliedPromotions ?? []).map((p) => p.promotionId)),
    ];

    if (promotionIds.length === 0) {
      if (dto.discountType === 'ORDER' && !dto.discountValue) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_DISCOUNT_VALUE_REQUIRED,
          message:
            'An order-level discount needs a discountValue greater than 0',
        });
      }
      return {
        lines,
        appliedPromotions: [],
        discountType: dto.discountType ?? null,
        discountValue: dto.discountValue ?? 0,
      };
    }

    // One discountType per order, so the two kinds can't be stacked - the schema has nowhere to record a total that is part manual and part promotion.
    if (dto.discountType === 'ORDER') {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DISCOUNT_CONFLICT,
        message:
          'An order cannot carry both an order-level discount and a promotion',
      });
    }

    const pricing = await this.promotions.calculate(tenantId, {
      branchId: dto.branchId,
      customerId: dto.customerId,
      items: lines.map((line) => ({
        productItemId: line.productItemId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
      promotionIds,
    });

    // Joined by position, never by `productItemId`: the engine returns one entry per cart line in cart order, and keying by variant id collapsed duplicate lines, handing each the sum of their shares - ten identical lines under a 10% promotion came out at 100% off.
    if (pricing.itemBreakdown.length !== lines.length) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_PROMOTION_ALLOCATION_MISMATCH,
        message: 'The discount could not be matched to the order lines',
      });
    }

    return {
      // The engine's allocation replaces whatever the client sent, including a manual line discount: two discounts on one line have no home in the schema.
      lines: lines.map((line, index) => ({
        ...line,
        discountAmount: pricing.itemBreakdown[index].discountAmount,
      })),
      appliedPromotions: pricing.appliedPromotions,
      discountType: 'PROMOTION',
      discountValue: pricing.totalDiscount,
    };
  }

  /** A sale with nobody attached still needs a customer row, so each tenant gets one walk-in record created on first use - an `upsert`, since two anonymous sales at once would both find nothing and both insert. */
  private async resolveWalkInCustomer(
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

  /** SePay can't be offered without somewhere for the money to land. */
  private async requireBanking(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        bankingBankName: true,
        bankingAccountNumber: true,
        bankingAccountName: true,
      },
    });
    if (!tenant?.bankingAccountNumber || !tenant.bankingBankName) {
      throw new BadRequestException({
        code: ErrorCode.TENANT_BANKING_NOT_CONFIGURED,
        message:
          'This shop has not configured its bank details for SePay payments',
      });
    }
    return tenant;
  }

  /** Resolves each line's variant and fills in the product name for the receipt. */
  /** The lines of a sale, priced from the catalogue. `unitPrice` comes from `ProductItem.retailPrice`, never the request, which used to let `unitPrice: 0` ring up a full basket for nothing. The manual per-line discount is capped at the line's own total and going over is a 400, not a silent trim - clamping would leave the stored `discount_amount` larger than the discount given, and `/stats/top-products` would report that product's revenue as negative. */
  private async priceLines(tenantId: string, dto: CreateOrderDto) {
    const ids = [...new Set(dto.items.map((item) => item.productItemId))];
    const variants = await this.prisma.productItem.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, sku: true, productName: true, retailPrice: true },
    });
    if (variants.length !== ids.length) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found in this order',
      });
    }
    const byId = new Map(variants.map((v) => [v.id, v]));

    return dto.items.map((item) => {
      const variant = byId.get(item.productItemId)!;
      const unitPrice = Number(variant.retailPrice);
      const discountAmount = item.discountAmount ?? 0;
      // Rounded the same way `grandTotalOf` rounds the line, so the cap and the subtraction agree to the đồng.
      const lineTotal = Math.round(item.quantity * unitPrice);
      if (discountAmount > lineTotal) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_LINE_DISCOUNT_EXCEEDS_TOTAL,
          message: `A discount of ${discountAmount} exceeds the line total for ${variant.sku ?? variant.productName} (${lineTotal})`,
        });
      }
      return {
        productItemId: item.productItemId,
        productName: variant.productName,
        sku: variant.sku,
        quantity: item.quantity,
        unitPrice,
        discountAmount,
      };
    });
  }

  /** What the customer actually owes: line totals minus per-line discounts, then a manual whole-order discount. A PROMOTION discount is not subtracted again - `priceOrder` has already spread it across the lines. Never below zero. */
  private grandTotalOf(
    lines: { quantity: number; unitPrice: number; discountAmount: number }[],
    discountType: string | null,
    discountValue: number,
  ): number {
    // Each line is rounded before its discount comes off, exactly as `pricing-engine.ts` does; rounding once at the end would leave a promotion sale a đồng or two from the total the preview quoted.
    const afterLineDiscounts = lines.reduce(
      (sum, line) =>
        sum +
        Math.max(
          0,
          Math.round(line.quantity * line.unitPrice) - line.discountAmount,
        ),
      0,
    );
    // Capped at what the order is actually worth: `Math.max(0, …)` alone only stopped the total going negative, so a cashier could still settle any basket at 0đ.
    const orderDiscount =
      discountType === 'ORDER'
        ? Math.min(Math.max(0, discountValue), afterLineDiscounts)
        : 0;
    return Math.max(0, Math.round(afterLineDiscounts - orderDiscount));
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
    paymentMethod: string,
    createdById: string,
  ) {
    const change = Number(order.change ?? 0);
    const givesChange =
      paymentMethod === PaymentMethod.CASH &&
      change > 0 &&
      order.customerPay !== null;

    await tx.cashFlow.create({
      data: {
        tenantId: order.tenantId,
        branchId: order.branchId,
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
          branchId: order.branchId,
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
