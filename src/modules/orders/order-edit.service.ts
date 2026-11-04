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
import {
  assertFulfillmentTypeChangeAllowed,
  assertNoPickupShippingFee,
} from './order-pickup.rules';
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
import { FINAL_SHIPMENT_STATUSES } from '../../common/constants/shipment-status';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { Prisma } from '../../../generated/prisma/client';

export interface EditedDeposit {
  amount: number;
  percent: number | null;
}

/**
 * Cọc sau khi sửa: cọc gửi kèm được xử lý như lúc tạo; không thì cọc theo % bám theo tổng mới, cọc số tiền thì giữ nguyên. Số đã thu không tự đổi, thu thêm hay hoàn bớt là việc của E-5. Nếu kết quả khác số shop đang giữ, lần sửa bị từ chối với `ORDER_DEPOSIT_CHANGED` kèm cả hai số, để client hỏi người dùng.
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
 * Sửa đơn hành trình trước khi giao (A-8, contract §2): `PATCH /orders/:id`, `/assignee`, `/priority`. Cho phép khi CONFIRMED / PACKED / PICKED_UP, không bao giờ cho đơn bán tại quầy.
 * Chỉ đổi dòng khi còn CONFIRMED: sau đóng gói, hàng trên kệ khóa đúng các dòng đó, và việc khóa lại khi sửa bị xét là không đáng rủi ro (2026-10-06) nên phải hủy rồi tạo lại.
 * Các thứ khác (người phụ trách, ưu tiên, tiền, thông tin giao) đổi được tới SHIPPING. Không đụng tới tồn kho.
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

    // Khách tới lấy: đổi hình thức giao có ràng buộc, và không có phí giao hàng (khi đổi sang đây phải gửi shippingFee = 0).
    const nextType = dto.fulfillmentType ?? order.fulfillmentType;
    if (nextType !== order.fulfillmentType) {
      assertFulfillmentTypeChangeAllowed(
        order,
        nextType,
        await this.prisma.shipment.count({
          where: {
            orderId: id,
            status: { notIn: [...FINAL_SHIPMENT_STATUSES] },
          },
        }),
      );
    }
    if (nextType === FulfillmentType.STORE_PICKUP) {
      assertNoPickupShippingFee(shippingFee);
    }

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

    // Dòng mới dựng trước transaction như lúc tạo: mở combo cần đọc danh mục.
    const addedLines = money ? money.lines.filter((line) => !line.id) : [];
    const addedRows =
      addedLines.length > 0
        ? this.manual.buildItems(
            addedLines,
            await this.manual.expandCombos(tenantId, addedLines),
          )
        : [];

    // Tạo khách trước transaction như lúc tạo: CustomerService giữ dãy mã và quy tắc một số điện thoại một khách.
    const typedInCustomerId =
      !dto.customerId && dto.customer
        ? await this.customers.findOrCreateForOrder(tenantId, dto.customer)
        : undefined;
    const customerId = dto.customerId ?? typedInCustomerId;

    // Chỉ đổi dòng mới làm thay đổi nhu cầu trên danh sách sản xuất (B-3).
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
      // Chiếm đơn theo bản ghi vừa đọc: đóng gói, hủy hoặc sửa khác xen giữa thì lần này thua trọn.
      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: order.status,
          updatedAt: order.updatedAt,
        },
        data: {
          ...(customerId ? { customerId } : {}),
          // Cột bắt buộc bỏ qua null; cột ghi chú tự do coi null là "xóa".
          ...sent(dto, ['assigneeId', 'fulfillmentType', 'priority'], false),
          ...sent(
            dto,
            ['recipientName', 'recipientPhone', 'deliveryAddress', 'note'],
            true,
          ),
          // Đổi sang khách tới lấy thì địa chỉ giao không còn nghĩa.
          ...(nextType === FulfillmentType.STORE_PICKUP &&
          nextType !== order.fulfillmentType
            ? { deliveryAddress: null }
            : {}),
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

  /** Đơn nếu người này được sửa lúc này: trong phạm vi quyền, thuộc hành trình và chưa giao. */
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
    // Đơn bán tại quầy đã thanh toán và giao xong ngay; sửa theo hành trình không áp dụng cho đơn này.
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

  /** Dòng gửi kèm `id` phải là dòng gốc của đơn này, chỉ nêu một lần và vẫn cùng sản phẩm. */
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

  /** Dòng mà xưởng được yêu cầu làm vẫn nằm trên đơn cho tới khi gỡ khỏi yêu cầu. */
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

  /** Chỉ đổi các trường được gửi, miễn là đơn chưa bắt đầu giao trong lúc đó. */
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

  /**
   * Tính lại giá đơn theo quy tắc lúc tạo. Trường bỏ trống được lấy từ đơn: dòng (dòng cũ giữ giá đã thỏa thuận trừ khi gửi giá mới),
   * khuyến mãi và giảm giá tay.
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

    // Id Branch là id Location nên chi nhánh là phương án cuối (như lúc tạo).
    const defaultSource =
      order.branch.location.defaultFulfillmentLocationId ?? order.branchId;
    const lines = priced.lines.map((line, index) => {
      const existing = items[index].id ? byId.get(items[index].id) : undefined;
      return {
        ...line,
        id: existing?.id,
        // Giá danh mục đã chụp lúc dòng được bán lần đầu vẫn là giá niêm yết của dòng.
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
   * Ghi các dòng đã có nhưng được tính lại giá: dòng bị bỏ thì xóa (con combo đi theo nhờ cascade), dòng giữ thì cập nhật tại chỗ,
   * con combo co giãn theo số lượng mới và chuyển sang kho xuất mới. Dòng mới do bên gọi insert.
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
        // Con mang số lượng = (số combo × số lượng của nó trong combo), nên số đếm được suy ra từ số lượng cũ.
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

/** Kho xuất của dòng đã có. Dòng COMBO không lưu kho (các thành phần mang), nên lấy từ thành phần đầu tiên có hàng. */
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

/** Các trường trong `dto` mà thực sự được gửi; null chỉ tính là gửi khi trường cho phép null. */
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
