import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerService } from '../customers/customers.service';
import { OrderService } from './orders.service';
import { OrderPricingService, type PricedLine } from './order-pricing.service';
import { OrderReadService } from './order-read.service';
import type { PricingResult } from '../promotions/pricing-engine';
import {
  ManualOrderService,
  paymentStatusForDeposit,
  resolveDeposit,
} from './manual-order.service';
import { depositHeld } from './order-cancel.service';
import { OrderShortageAlerts } from './order-shortage-alerts';
import {
  SetOrderAssigneeDto,
  SetOrderPriorityDto,
  UpdateOrderDto,
  UpdateOrderItemDto,
} from './dto/update-order.dto';
import {
  FulfillmentType,
  OrderLineType,
  OrderStatus,
  UNSHIPPED_ORDER_STATUSES,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';

/** The deposit an order should carry after an edit. */
export interface EditedDeposit {
  amount: number;
  /** Only when the deposit is a percentage. */
  percent: number | null;
}

/**
 * The deposit after an edit (A-8, contract §2 "Tiền cọc"). A deposit sent with the edit is resolved
 * as on create; otherwise a percentage deposit follows the new grand total and an amount stays as it
 * was. The money already taken does not move with it - recording more or giving some back is E-5's
 * - so if the result differs from what the shop holds, the edit is refused with
 * ORDER_DEPOSIT_CHANGED and both numbers, and the client asks the user (who can resend the deposit
 * as the amount held to keep it).
 */
export function resolveEditedDeposit(input: {
  sent: { type: string; value: number; method: string } | undefined;
  stored: EditedDeposit | null;
  grandTotal: number;
  held: number;
}): EditedDeposit | null {
  const { sent, stored, grandTotal, held } = input;
  let next: EditedDeposit | null;
  if (sent) {
    const resolved = resolveDeposit(sent, grandTotal);
    next = resolved
      ? { amount: resolved.amount, percent: resolved.percent }
      : null;
  } else if (stored?.percent != null) {
    next = {
      amount: Math.round((grandTotal * stored.percent) / 100),
      percent: stored.percent,
    };
  } else if (stored) {
    if (stored.amount > grandTotal) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL,
        message: `The deposit of ${stored.amount} exceeds the new order total of ${grandTotal}`,
      });
    }
    next = stored;
  } else {
    next = null;
  }

  const amount = next?.amount ?? 0;
  if (amount !== held) {
    throw new ConflictException({
      code: ErrorCode.ORDER_DEPOSIT_CHANGED,
      message: `The deposit would become ${amount} but ${held} has been taken`,
      deposit: { held, amount, difference: amount - held },
    });
  }
  return next;
}

type ExistingLine = {
  id: string;
  productItemId: string;
  parentItemId: string | null;
  lineType: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  listUnitPrice: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  sourceLocationId: string | null;
};

/**
 * Editing a journey order before it ships (A-8, contract §2): `PATCH /orders/:id`,
 * `/assignee`, `/priority`. Allowed while CONFIRMED / PACKED / PICKED_UP, never for a till sale.
 * Lines change only while CONFIRMED: after packing, the goods on the shelf are locked to exactly
 * those lines, and re-locking on an edit was judged not worth its bugs (2026-10-06) - cancel and
 * re-create instead. Everything else (person in charge, priority, money, delivery details) can
 * still change until SHIPPING. Nothing here touches stock.
 */
@Injectable()
export class OrderEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrderService,
    private readonly manual: ManualOrderService,
    private readonly pricing: OrderPricingService,
    private readonly reads: OrderReadService,
    private readonly customers: CustomerService,
    private readonly shortages: OrderShortageAlerts,
  ) {}

  async update(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: UpdateOrderDto,
  ) {
    const order = await this.loadEditable(user, tenantId, id);
    if (dto.items && order.status !== OrderStatus.CONFIRMED) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_EDITABLE,
        message: `The lines of an order in ${order.status} are packed and cannot change; cancel and re-create it`,
      });
    }
    if (dto.assigneeId)
      await this.manual.assertAssignee(tenantId, dto.assigneeId);
    if (dto.customerId)
      await this.orders.assertCustomerExists(tenantId, dto.customerId);

    const topLines = order.items.filter((line) => !line.parentItemId);
    const byId = new Map(topLines.map((line) => [line.id, line]));
    if (dto.items) this.assertLineIds(dto.items, byId);

    const reprice =
      dto.items !== undefined ||
      dto.discountType !== undefined ||
      dto.discountValue !== undefined ||
      dto.appliedPromotions !== undefined;
    const storedShipping = Number(order.shippingFee);
    const shippingFee =
      dto.shippingFee !== undefined
        ? Math.round(dto.shippingFee)
        : storedShipping;

    let money: Awaited<ReturnType<OrderEditService['reprice']>> | null = null;
    let grandTotal = Number(order.grandTotal) - storedShipping + shippingFee;
    if (reprice) {
      money = await this.reprice(tenantId, order, dto, topLines, byId);
      grandTotal = money.goodsTotal + shippingFee;
    }

    const removed = dto.items
      ? topLines.filter((line) => !dto.items!.some((i) => i.id === line.id))
      : [];
    if (removed.length > 0) await this.assertNotInProduction(order, removed);

    const deposit =
      dto.deposit !== undefined || grandTotal !== Number(order.grandTotal)
        ? resolveEditedDeposit({
            sent: dto.deposit,
            stored:
              order.depositAmount === null
                ? null
                : {
                    amount: Number(order.depositAmount),
                    percent:
                      order.depositPercent === null
                        ? null
                        : Number(order.depositPercent),
                  },
            grandTotal,
            held: depositHeld(
              order.payments.map((p) => ({ ...p, amount: Number(p.amount) })),
            ),
          })
        : undefined;

    // New lines are built before the transaction, as on create: expanding a combo reads the catalogue.
    const addedLines = money ? money.lines.filter((line) => !line.id) : [];
    const addedRows =
      addedLines.length > 0
        ? this.manual.buildItems(
            addedLines,
            await this.manual.expandCombos(tenantId, addedLines),
          )
        : [];

    // Created before the transaction, as on create: CustomerService owns the code sequence and the one-phone rule.
    const typedInCustomerId =
      !dto.customerId && dto.customer
        ? await this.customers.findOrCreateForOrder(tenantId, dto.customer)
        : undefined;
    const customerId = dto.customerId ?? typedInCustomerId;

    // Only a change of lines moves demand on the production list (B-3).
    const shortage = dto.items
      ? await this.shortages.snapshot(tenantId, [
          ...order.items,
          ...(money?.lines ?? []).map((line) => ({
            productItemId: line.productItemId,
            sourceLocationId: line.sourceLocationId,
            lineType: line.itemType,
          })),
          ...addedRows,
        ])
      : null;

    await this.prisma.$transaction(async (tx) => {
      // Claimed on the row as read: a pack, a cancel or another edit in between loses this one whole.
      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: order.status,
          updatedAt: order.updatedAt,
        },
        data: {
          ...(customerId ? { customerId } : {}),
          // Required columns ignore a null; the free-text ones take it as "clear".
          ...sent(dto, ['assigneeId', 'fulfillmentType', 'priority'], false),
          ...sent(
            dto,
            ['recipientName', 'recipientPhone', 'deliveryAddress', 'note'],
            true,
          ),
          ...(dto.requestedDeliveryDate !== undefined
            ? {
                requestedDeliveryDate: dto.requestedDeliveryDate
                  ? new Date(dto.requestedDeliveryDate)
                  : null,
              }
            : {}),
          shippingFee,
          grandTotal,
          ...(money
            ? {
                subtotal: money.subtotal,
                discountType: money.discountType,
                discountValue: money.discountValue,
              }
            : {}),
          ...(deposit !== undefined
            ? {
                depositAmount: deposit?.amount ?? null,
                depositPercent: deposit?.percent ?? null,
                paymentStatus: paymentStatusForDeposit(
                  deposit?.amount ?? 0,
                  grandTotal,
                ),
              }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }
      if (!money) return;

      await tx.orderAppliedPromotion.deleteMany({ where: { orderId: id } });
      if (money.appliedPromotions.length > 0) {
        await tx.orderAppliedPromotion.createMany({
          data: money.appliedPromotions.map(
            (p: PricingResult['appliedPromotions'][number]) => ({
              orderId: id,
              promotionId: p.promotionId,
              promoName: p.promoName,
              discountAmount: p.discountAmount,
            }),
          ),
        });
      }
      await this.writeLines(tx, order, removed, money.lines, byId);
      if (addedRows.length > 0) {
        await tx.orderItem.createMany({
          data: addedRows.map((row) => ({ ...row, orderId: id })),
        });
      }
    });

    if (shortage)
      await this.shortages.notify(tenantId, id, shortage, user.userId);
    return this.reads.findOne(user, tenantId, id);
  }

  async setAssignee(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: SetOrderAssigneeDto,
  ) {
    await this.loadEditable(user, tenantId, id);
    await this.manual.assertAssignee(tenantId, dto.assigneeId);
    await this.claimUnshipped(tenantId, id, { assigneeId: dto.assigneeId });
    return this.reads.findOne(user, tenantId, id);
  }

  async setPriority(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: SetOrderPriorityDto,
  ) {
    await this.loadEditable(user, tenantId, id);
    await this.claimUnshipped(tenantId, id, { priority: dto.priority });
    return this.reads.findOne(user, tenantId, id);
  }

  // ─── Rules ─────────────────────────────────────────────────────────────────

  /** The order, if this user may edit it now: in their scope, from the journey, not yet shipping. */
  private async loadEditable(user: AuthUser, tenantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: true,
        payments: true,
        appliedPromotions: { select: { promotionId: true } },
        branch: {
          select: {
            location: { select: { defaultFulfillmentLocationId: true } },
          },
        },
      },
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    // A till sale is paid and gone at the counter; the journey's edit never applies to it.
    if (
      order.fulfillmentType === FulfillmentType.TAKEAWAY ||
      !UNSHIPPED_ORDER_STATUSES.includes(order.status)
    ) {
      throw new ConflictException({
        code: ErrorCode.ORDER_NOT_EDITABLE,
        message:
          order.fulfillmentType === FulfillmentType.TAKEAWAY
            ? 'A counter sale cannot be edited'
            : `An order in ${order.status} can no longer be edited`,
      });
    }
    return order;
  }

  /** A line sent with an `id` must be one of this order's own top-level lines, named once, still the same product. */
  private assertLineIds(
    items: readonly UpdateOrderItemDto[],
    byId: ReadonlyMap<string, ExistingLine>,
  ) {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item.id) continue;
      const line = byId.get(item.id);
      if (!line || seen.has(item.id)) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_ITEM_NOT_FOUND,
          message: `Line ${item.id} is not a line of this order`,
        });
      }
      seen.add(item.id);
      if (line.productItemId !== item.productItemId) {
        throw new BadRequestException({
          code: ErrorCode.ORDER_NOT_EDITABLE,
          message: `Line ${item.id} cannot change product; remove it and add the new one`,
        });
      }
    }
  }

  /** A line the workshop has been asked to make stays on the order until it is taken off the request. */
  private async assertNotInProduction(
    order: { items: ExistingLine[] },
    removed: readonly ExistingLine[],
  ) {
    const removedIds = new Set(removed.map((line) => line.id));
    const ids = order.items
      .filter(
        (line) =>
          removedIds.has(line.id) ||
          (line.parentItemId !== null && removedIds.has(line.parentItemId)),
      )
      .map((line) => line.id);
    const inProduction = await this.prisma.productionRequestItem.findFirst({
      where: { orderItemId: { in: ids } },
      select: { productionRequest: { select: { code: true } } },
    });
    if (inProduction) {
      throw new ConflictException({
        code: ErrorCode.ORDER_ITEM_IN_PRODUCTION,
        message: `A removed line is on production request ${inProduction.productionRequest.code}`,
      });
    }
  }

  /** Changes only the fields given, as long as the order has not started shipping in the meantime. */
  private async claimUnshipped(
    tenantId: string,
    id: string,
    data: Prisma.OrderUncheckedUpdateManyInput,
  ) {
    const claimed = await this.prisma.order.updateMany({
      where: { id, tenantId, status: { in: [...UNSHIPPED_ORDER_STATUSES] } },
      data,
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: ErrorCode.ORDER_STATUS_CONFLICT,
        message: 'The order has just changed, please reload',
      });
    }
  }

  // ─── Money and lines ───────────────────────────────────────────────────────

  /**
   * Prices the order again through the create's rules. A field left out of the edit is read off the
   * order: its lines (an existing line keeps its agreed price unless a new one is sent), its
   * promotions and its manual discount.
   */
  private async reprice(
    tenantId: string,
    order: Awaited<ReturnType<OrderEditService['loadEditable']>>,
    dto: UpdateOrderDto,
    topLines: readonly ExistingLine[],
    byId: ReadonlyMap<string, ExistingLine>,
  ) {
    const items = dto.items
      ? dto.items.map((item) => ({
          ...item,
          unitPrice:
            item.unitPrice ??
            (item.id ? Number(byId.get(item.id)!.unitPrice) : undefined),
        }))
      : topLines.map((line) => ({
          id: line.id,
          productItemId: line.productItemId,
          quantity: line.quantity,
          unitPrice: Number(line.unitPrice),
          discountAmount: Number(line.discountAmount),
          sourceLocationId: line.sourceLocationId ?? undefined,
        }));
    if (dto.items) await this.manual.assertSourceLocations(tenantId, dto.items);

    const keptOrderDiscount = order.discountType === 'ORDER';
    const discountType =
      dto.discountType !== undefined
        ? (dto.discountType ?? undefined)
        : keptOrderDiscount
          ? 'ORDER'
          : undefined;
    const discountValue =
      dto.discountValue ??
      (discountType === 'ORDER' && keptOrderDiscount
        ? Number(order.discountValue)
        : undefined);

    const priced = await this.pricing.priceOrder(tenantId, {
      branchId: order.branchId,
      customerId: dto.customerId ?? order.customerId,
      items,
      appliedPromotions:
        dto.appliedPromotions ??
        order.appliedPromotions
          .filter((p): p is { promotionId: string } => p.promotionId !== null)
          .map((p) => ({ promotionId: p.promotionId })),
      discountType,
      discountValue,
    });
    this.manual.assertSellableLines(priced.lines);

    // A Branch's id is its Location's id, so the branch itself is the last fallback (as on create).
    const defaultSource =
      order.branch.location.defaultFulfillmentLocationId ?? order.branchId;
    const lines = priced.lines.map((line, index) => {
      const existing = items[index].id ? byId.get(items[index].id) : undefined;
      return {
        ...line,
        id: existing?.id,
        // The catalogue price snapshotted when the line was first sold stays the line's list price.
        listUnitPrice:
          existing?.listUnitPrice != null
            ? Number(existing.listUnitPrice)
            : line.listUnitPrice,
        sourceLocationId:
          items[index].sourceLocationId ??
          (existing && sourceOf(existing, order.items)) ??
          defaultSource,
      };
    });

    return {
      lines,
      appliedPromotions: priced.appliedPromotions,
      discountType: priced.discountType,
      discountValue: priced.discountValue,
      subtotal: lines.reduce(
        (sum, line) => sum + this.pricing.lineTotalOf(line),
        0,
      ),
      goodsTotal: this.pricing.grandTotalOf(
        lines,
        priced.discountType,
        priced.discountValue,
      ),
    };
  }

  /**
   * Writes the repriced lines that already exist: removed lines go (a combo's children with them, by
   * cascade), a kept line is updated in place - its combo children scaled to the new quantity and
   * moved to its new ship-from location. New lines are inserted by the caller.
   */
  private async writeLines(
    tx: Prisma.TransactionClient,
    order: { items: ExistingLine[] },
    removed: readonly ExistingLine[],
    lines: readonly (PricedLine & {
      id: string | undefined;
      sourceLocationId: string;
    })[],
    byId: ReadonlyMap<string, ExistingLine>,
  ) {
    if (removed.length > 0) {
      await tx.orderItem.deleteMany({
        where: { id: { in: removed.map((line) => line.id) } },
      });
    }

    for (const line of lines) {
      if (!line.id) continue;
      const existing = byId.get(line.id)!;
      const holdsStock =
        line.itemType !== OrderLineType.COMBO &&
        line.itemType !== OrderLineType.SERVICE;
      await tx.orderItem.update({
        where: { id: line.id },
        data: {
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
          lineTotal: this.pricing.lineTotalOf(line),
          sourceLocationId: holdsStock ? line.sourceLocationId : null,
        },
      });
      if (line.itemType !== OrderLineType.COMBO) continue;
      for (const child of order.items) {
        if (child.parentItemId !== line.id) continue;
        // A child carries (combo quantity × its own count in the combo), so the count is recovered from the old quantities.
        const perCombo = child.quantity / existing.quantity;
        await tx.orderItem.update({
          where: { id: child.id },
          data: {
            quantity: perCombo * line.quantity,
            sourceLocationId:
              child.lineType === OrderLineType.SERVICE
                ? null
                : line.sourceLocationId,
          },
        });
      }
    }
  }
}

/** Where an existing line ships from. A COMBO line stores none - its components carry it - so it is read off the first one that holds stock. */
function sourceOf(
  line: ExistingLine,
  all: readonly ExistingLine[],
): string | null {
  if (line.sourceLocationId) return line.sourceLocationId;
  return (
    all.find(
      (child) => child.parentItemId === line.id && child.sourceLocationId,
    )?.sourceLocationId ?? null
  );
}

/** The listed fields of `dto` that were actually sent - a null counting as sent only where `nullable`. */
function sent<T extends object, K extends keyof T>(
  dto: T,
  keys: readonly K[],
  nullable: boolean,
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    const value = dto[key];
    if (value === undefined || (value === null && !nullable)) continue;
    out[key] = value;
  }
  return out;
}
