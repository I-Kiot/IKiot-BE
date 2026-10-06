import { randomUUID } from 'node:crypto';
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
import { CreateOrderDto, DepositType } from './dto/create-order.dto';
import {
  type ComboEdge,
  type ComboLeaf,
  flattenCombo,
  MAX_COMBO_DEPTH,
} from './combo-expansion';
import {
  OrderChannel,
  OrderItemStatus,
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
    const now = new Date();

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
      return created.id;
    });

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

  /** What each COMBO line in the order finally contains, keyed by the combo's variant id (`flattenCombo`). The combo graph is loaded one nesting level per query - never one query per combo - and every level is bounded by `MAX_COMBO_DEPTH`. */
  async expandCombos(tenantId: string, lines: readonly PricedLine[]) {
    const comboIds = [
      ...new Set(
        lines
          .filter((line) => line.itemType === OrderLineType.COMBO)
          .map((line) => line.productItemId),
      ),
    ];
    const childrenOf = new Map<string, ComboEdge[]>();
    let frontier = comboIds;
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth > MAX_COMBO_DEPTH) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_COMBO_INVALID,
          message: `A combo nests deeper than ${MAX_COMBO_DEPTH} levels`,
        });
      }
      const edges = await this.prisma.comboComponent.findMany({
        where: { comboItemId: { in: frontier }, comboItem: { tenantId } },
        select: {
          comboItemId: true,
          quantity: true,
          componentItem: {
            select: {
              id: true,
              sku: true,
              productName: true,
              vat: true,
              itemType: true,
            },
          },
        },
      });
      for (const id of frontier) childrenOf.set(id, []);
      for (const edge of edges) childrenOf.get(edge.comboItemId)!.push(edge);
      // A sub-combo already loaded (or a cycle back to one) is not fetched again; `flattenCombo` reports the cycle.
      frontier = [
        ...new Set(
          edges
            .map((edge) => edge.componentItem)
            .filter(
              (item) =>
                item.itemType === OrderLineType.COMBO &&
                !childrenOf.has(item.id),
            )
            .map((item) => item.id),
        ),
      ];
    }
    return new Map(comboIds.map((id) => [id, flattenCombo(id, childrenOf)]));
  }

  /** The order's lines as rows: each priced line, and under every COMBO line one child per leaf it finally contains (nested combos already flattened), at price 0 - the combo line carries the money, the children carry the stock and ship from the combo's location. A child is COMBO_COMPONENT, or SERVICE when the leaf is a service; SERVICE lines need no goods, so they ship from nowhere. */
  buildItems(
    lines: readonly (PricedLine & { sourceLocationId: string })[],
    components: Map<string, ComboLeaf[]>,
  ): Prisma.OrderItemCreateManyOrderInput[] {
    const rows: Prisma.OrderItemCreateManyOrderInput[] = [];
    for (const line of lines) {
      const id = randomUUID();
      const isCombo = line.itemType === OrderLineType.COMBO;
      rows.push({
        id,
        productItemId: line.productItemId,
        status: OrderItemStatus.PENDING,
        lineType: line.itemType,
        // A COMBO line is priced only, so it has no stock to locate; its children do.
        sourceLocationId:
          isCombo || line.itemType === OrderLineType.SERVICE
            ? null
            : line.sourceLocationId,
        productName: line.productName,
        sku: line.sku,
        listUnitPrice: line.listUnitPrice,
        vatRate: line.vatRate,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        lineTotal: this.pricing.lineTotalOf(line),
      });
      if (!isCombo) continue;
      for (const leaf of components.get(line.productItemId) ?? []) {
        const isService = leaf.item.itemType === OrderLineType.SERVICE;
        rows.push({
          productItemId: leaf.item.id,
          status: OrderItemStatus.PENDING,
          lineType: isService
            ? OrderLineType.SERVICE
            : OrderLineType.COMBO_COMPONENT,
          parentItemId: id,
          sourceLocationId: isService ? null : line.sourceLocationId,
          productName: leaf.item.productName,
          sku: leaf.item.sku,
          vatRate: leaf.item.vat as Prisma.Decimal | null,
          quantity: line.quantity * leaf.quantity,
          listUnitPrice: 0,
          unitPrice: 0,
          discountAmount: 0,
          lineTotal: 0,
        });
      }
    }
    return rows;
  }
}
