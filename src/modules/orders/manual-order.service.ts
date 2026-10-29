import { InvoiceService } from '../invoices/invoices.service';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerService } from '../customers/customers.service';
import { OrderService } from './orders.service';
import { OrderPricingService, type PricedLine } from './order-pricing.service';
import { OrderCustomizationService } from './order-customization.service';
import { OrderShortageAlerts } from './order-shortage-alerts';
import { CreateOrderDto, DepositType } from './dto/create-order.dto';
import type { ComboLeaf } from './combo-expansion';
import { buildOrderItemRows, expandCombos } from './order-combo';
import {
  OrderChannel,
  OrderLineType,
  OrderPaymentStatus,
  OrderPriority,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { LocationStatus } from '../../common/constants/location-status';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';

/** Account kinds that can be put in charge of an order. */
const ASSIGNABLE_ROLES: readonly string[] = [
  SystemRole.TENANT_OWNER,
  SystemRole.STAFF,
];

/** Deposit worked out from the request: what is stored on the order and what the DEPOSIT payment carries. */
export interface ResolvedDeposit {
  amount: number;
  /** Only when the deposit was entered as a percentage. */
  percent: number | null;
  method: string;
}

/** `ProductItem.itemType` (PRODUCT | COMBO | SERVICE) is the same vocabulary as the line types a sold item can start as; COMBO_COMPONENT is never sent by a client, only added under a COMBO here. */
const SELLABLE_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO,
  OrderLineType.SERVICE,
];

/**
 * The deposit on a manual order (contract §2 "Tiền cọc"): a PERCENT is taken of the grand total and
 * rounded to the đồng, an AMOUNT as given. Zero means no deposit at all. More than the order is
 * worth is refused rather than capped - the customer handed over a real sum. (`orders_deposit_valid`
 * enforces the same bounds in SQL.)
 */
export function resolveDeposit(
  deposit: { type: string; value: number; method: string } | undefined,
  grandTotal: number,
): ResolvedDeposit | null {
  if (!deposit) return null;
  let amount: number;
  let percent: number | null = null;
  if (deposit.type === DepositType.PERCENT) {
    if (deposit.value > 100) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL,
        message: `A deposit of ${deposit.value}% exceeds the order total`,
      });
    }
    percent = deposit.value;
    amount = Math.round((grandTotal * deposit.value) / 100);
  } else {
    amount = Math.round(deposit.value);
  }
  if (amount > grandTotal) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL,
      message: `A deposit of ${amount} exceeds the order total of ${grandTotal}`,
    });
  }
  if (amount === 0) return null;
  return { amount, percent, method: deposit.method };
}

/** An order's `paymentStatus` while its only money is the deposit (before delivery collects the rest). */
export function paymentStatusForDeposit(
  depositAmount: number,
  grandTotal: number,
): string {
  if (depositAmount <= 0) return OrderPaymentStatus.UNPAID;
  return depositAmount >= grandTotal
    ? OrderPaymentStatus.PAID
    : OrderPaymentStatus.PARTIALLY_PAID;
}

/** The order journey's `POST /orders` (A-2, contract §2): a manual order staff type in for a customer who ordered online or by phone. It is born CONFIRMED with a person in charge, holds no stock and is never refused for stock - packing (C-1) is where shortage blocks. The till's sale is `OrderService.createPosSale`. */
@Injectable()
export class ManualOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly pricing: OrderPricingService,
    private readonly customers: CustomerService,
    private readonly customizations: OrderCustomizationService,
    private readonly shortages: OrderShortageAlerts,
    private readonly invoices: InvoiceService,
  ) {}

  async create(user: AuthUser, tenantId: string, dto: CreateOrderDto) {
    const userId = user.userId;
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && dto.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'You can only create orders for your own branch',
      });
    }
    if (!dto.assigneeId) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_REQUIRED,
        message: 'A manual order needs a person in charge',
      });
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
      select: {
        id: true,
        location: { select: { defaultFulfillmentLocationId: true } },
      },
    });
    if (!branch)
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });

    await this.assertAssignee(tenantId, dto.assigneeId);
    if (dto.customerId)
      await this.orders.assertCustomerExists(tenantId, dto.customerId);

    // A Branch's id is its Location's id, so the branch itself is the last fallback.
    const defaultSource =
      branch.location.defaultFulfillmentLocationId ?? branch.id;
    await this.assertSourceLocations(tenantId, dto.items);

    const priced = await this.pricing.priceOrder(tenantId, dto);
    const { appliedPromotions, discountType, discountValue } = priced;
    const lines = priced.lines.map((line, index) => ({
      ...line,
      sourceLocationId: dto.items[index].sourceLocationId ?? defaultSource,
    }));
    this.assertSellableLines(lines);
    lines.forEach((line, index) => {
      if (dto.items[index].customization)
        this.customizations.assertCustomizable(line.itemType);
    });
    const components = await this.expandCombos(tenantId, lines);

    const subtotal = lines.reduce(
      (sum, line) => sum + this.pricing.lineTotalOf(line),
      0,
    );
    const goodsTotal = this.pricing.grandTotalOf(
      lines,
      discountType,
      discountValue,
    );
    const shippingFee = Math.round(dto.shippingFee ?? 0);
    const grandTotal = goodsTotal + shippingFee;
    const deposit = resolveDeposit(dto.deposit, grandTotal);
    const paymentStatus = paymentStatusForDeposit(
      deposit?.amount ?? 0,
      grandTotal,
    );

    // Created before the transaction: CustomerService owns the code sequence and the one-phone-one-customer rule. Everything that can refuse the order has already run, so a stray customer row needs a database failure to be left behind - and is a real customer either way.
    const typedInCustomerId =
      !dto.customerId && dto.customer
        ? await this.customers.findOrCreateForOrder(tenantId, dto.customer)
        : undefined;

    const items = this.buildItems(lines, components);
    // buildItems emits each sent line in order, its combo children right after it.
    const topLevelRows = items.filter((row) => !row.parentItemId);
    const now = new Date();

    const shortage = await this.shortages.snapshot(tenantId, items);

    const orderId = await this.prisma.$transaction(async (tx) => {
      const customerId =
        dto.customerId ??
        typedInCustomerId ??
        (await this.orders.resolveWalkInCustomer(tx, tenantId));

      const created = await tx.order.create({
        data: {
          tenantId,
          branchId: branch.id,
          customerId,
          code: generateReference(REFERENCE_PREFIX.ORDER),
          status: OrderStatus.CONFIRMED,
          priority: dto.priority ?? OrderPriority.NORMAL,
          channel: OrderChannel.MANUAL,
          fulfillmentType: dto.fulfillmentType,
          userId,
          assigneeId: dto.assigneeId,
          // Creating a manual order is confirming it (contract §2) - there is no draft step.
          confirmedById: userId,
          confirmedAt: now,
          subtotal,
          shippingFee,
          grandTotal,
          discountType,
          discountValue,
          depositAmount: deposit?.amount ?? null,
          depositPercent: deposit?.percent ?? null,
          paymentStatus,
          recipientName: dto.recipientName,
          recipientPhone: dto.recipientPhone,
          deliveryAddress: dto.deliveryAddress,
          requestedDeliveryDate: dto.requestedDeliveryDate
            ? new Date(dto.requestedDeliveryDate)
            : undefined,
          note: dto.note,
          // One statement for every line, so a combo's children can name a parent inserted alongside them.
          items: { createMany: { data: items } },
          appliedPromotions: { create: appliedPromotions },
        },
        select: { id: true },
      });

      if (deposit) {
        // The deposit is money already in hand, so its Payment is PAID now. Its CashFlow row is E-5's (`CashFlow.paymentId`), not written here.
        await tx.payment.create({
          data: {
            tenantId,
            orderId: created.id,
            kind: PaymentKind.DEPOSIT,
            method: deposit.method,
            amount: deposit.amount,
            status: PaymentRecordStatus.PAID,
            paidAt: now,
            locationId: branch.id,
            collectedById: userId,
            createdById: userId,
          },
        });
      }
      for (const [index, item] of dto.items.entries()) {
        if (!item.customization) continue;
        const row = topLevelRows[index];
        await this.customizations.apply(
          tx,
          tenantId,
          {
            id: row.id!,
            productItemId: row.productItemId,
            lineType: row.lineType!,
            isCustom: false,
          },
          item.customization,
        );
      }
      // Issued when the order is COMPLETED (delivered and paid); until then it is a PENDING invoice.
      await this.invoices.ensurePending(tx, created.id);
      return created.id;
    });

    await this.shortages.notify(tenantId, orderId, shortage, userId);
    return this.orders.findOne(user, tenantId, orderId);
  }

  /** Only a product, a combo or a service can be a line of its own; a combo's components are added by the server. */
  assertSellableLines(lines: readonly PricedLine[]) {
    for (const line of lines) {
      if (!SELLABLE_LINE_TYPES.includes(line.itemType)) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COMBO_INVALID,
          message: `${line.sku ?? line.productName} cannot be sold as an order line`,
        });
      }
    }
  }

  /** The person in charge has to be someone who can log in to this shop and work an order. Shared with the edit routes (A-8). */
  async assertAssignee(tenantId: string, assigneeId: string) {
    const assignee = await this.prisma.user.findFirst({
      where: {
        id: assigneeId,
        tenantId,
        status: UserStatus.ACTIVE,
        systemRole: { in: [...ASSIGNABLE_ROLES] },
      },
      select: { id: true },
    });
    if (!assignee) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_ASSIGNEE_INVALID,
        message: 'The person in charge is not an active account of this shop',
      });
    }
  }

  /** Every ship-from location named on a line must be one of the tenant's live locations, and one whose stock is for sale - a damaged-goods warehouse never ships to a customer. */
  async assertSourceLocations(
    tenantId: string,
    items: readonly { sourceLocationId?: string }[],
  ) {
    const ids = [
      ...new Set(
        items
          .map((item) => item.sourceLocationId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (ids.length === 0) return;
    const found = await this.prisma.location.findMany({
      where: { tenantId, id: { in: ids } },
      select: { id: true, status: true, isSellable: true },
    });
    const byId = new Map(found.map((location) => [location.id, location]));
    for (const id of ids) {
      const location = byId.get(id);
      if (!location || location.status !== LocationStatus.ACTIVE) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_SOURCE_LOCATION_INVALID,
          message: `Location ${id} cannot ship this order`,
        });
      }
      if (!location.isSellable) {
        throw new BadRequestException({
          code: ErrorCode.LOCATION_NOT_SELLABLE,
          message: `Location ${id} holds stock that is not for sale`,
        });
      }
    }
  }

  /** What each COMBO line in the order finally contains, keyed by the combo's variant id. The walk lives in `order-combo.ts`, shared with the till. */
  expandCombos(tenantId: string, lines: readonly PricedLine[]) {
    return expandCombos(this.prisma, tenantId, lines);
  }

  /** The order's lines as rows, each COMBO line followed by its children (`buildOrderItemRows`). */
  buildItems(
    lines: readonly (PricedLine & { sourceLocationId: string })[],
    components: Map<string, ComboLeaf[]>,
  ): Prisma.OrderItemCreateManyOrderInput[] {
    return buildOrderItemRows(lines, components, (line) =>
      this.pricing.lineTotalOf(line),
    );
  }
}
