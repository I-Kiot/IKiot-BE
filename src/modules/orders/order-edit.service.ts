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
import { ManualOrderService, resolveDeposit } from './manual-order.service';
import { lockOrder } from './order-lock';
import { derivePaymentStatus, syncOrderPaymentStatus } from './payment-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { toDong } from '../../common/utils/money';
import { depositHeld } from './order-cancel.service';
import {
  assertFulfillmentTypeChangeAllowed,
  assertNoCounterPayment,
  assertNoPickupShippingFee,
  openCounterQr,
} from './order-pickup.rules';
import { assertDeliveryInfoComplete } from './order-delivery.rules';
import { cancelCounterQr } from './order-pickup.service';
import { OrderShortageAlerts } from './order-shortage-alerts';
import { assertReassignAccess, assigneeClaim } from './order-handler';
import { toUserRef } from './order-read.mapper';
import { NotificationService } from '../notifications/notifications.service';
import { OrderNotificationTemplates } from '../notifications/templates/order.templates';
import { SystemRole } from '../../common/constants/system-role';
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
import { OrderEventType } from '../../common/constants/order-event-type';
import {
  diffOrderFields,
  diffOrderLines,
  displayNamesOf,
  type OrderEventInput,
  type OrderFieldValue,
  recordOrderEvents,
  userActor,
} from './order-events';
import { USER_REF_SELECT } from './order-read';

/** Trường của đơn mà nhật ký EDITED so trước/sau. Người phụ trách và mức ưu tiên có sự kiện riêng nên không nằm đây. */
const EDIT_FIELDS = [
  'recipientName',
  'recipientPhone',
  'deliveryAddress',
  'requestedDeliveryDate',
  'note',
  'fulfillmentType',
  'customer',
  'sourceLocation',
  'shippingFee',
  'discountType',
  'discountValue',
  'depositAmount',
  'grandTotal',
] as const;
type EditField = (typeof EDIT_FIELDS)[number];

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

/**
 * Sửa tiền của đơn đã có khoản thu thật thì lệch sổ, nên bị chặn:
 * - `ORDER_EDIT_LOCKED_BY_PAYMENT`: tổng tiền, phí giao, cọc hay các dòng đổi trong khi đã có khoản FULL / BALANCE đã thu (tiền thu tại quầy, tại cửa, hay shipper): huỷ đơn rồi tạo lại.
 * - `ORDER_TOTAL_BELOW_PAID`: tổng đơn mới thấp hơn số shop đang giữ (kèm `paid`, `grandTotal`). Cọc thì sửa được, miễn tổng mới không thấp hơn cọc.
 * Thuần (nhận các khoản đã đọc) để chạy cả ngoài lẫn trong transaction, sau khi khoá đơn.
 */
export function assertEditAllowedByPayments(
  payments: readonly { kind: string; status: string; amount: unknown }[],
  next: { grandTotal: number; moneyChanged: boolean },
): void {
  const settled = payments.some(
    (p) =>
      p.status === PaymentRecordStatus.PAID &&
      (p.kind === PaymentKind.FULL || p.kind === PaymentKind.BALANCE),
  );
  // Đơn chỉ có cọc thì luật cọc (`resolveEditedDeposit`: ORDER_DEPOSIT_EXCEEDS_TOTAL / ORDER_DEPOSIT_CHANGED) đã lo; hai mã mới chỉ áp cho đơn đã có khoản thu thật.
  if (!settled) return;
  const { net } = derivePaymentStatus(
    next.grandTotal,
    payments.map((p) => ({ ...p, amount: toDong(p.amount as number) })),
  );
  if (next.grandTotal < net) {
    throw new ConflictException({
      code: ErrorCode.ORDER_TOTAL_BELOW_PAID,
      message: `The new total of ${next.grandTotal} is below the ${net} already paid`,
      paid: net,
      grandTotal: next.grandTotal,
    });
  }
  if (next.moneyChanged) {
    throw new ConflictException({
      code: ErrorCode.ORDER_EDIT_LOCKED_BY_PAYMENT,
      message:
        'This order has already been paid at the counter or on delivery; its amounts can no longer change',
    });
  }
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
    private readonly notifications: NotificationService,
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
    if (dto.sourceLocationId) {
      if (order.status !== OrderStatus.CONFIRMED) {
        throw new ConflictException({
          code: ErrorCode.ORDER_NOT_EDITABLE,
          message: `An order in ${order.status} is packed; its source can no longer change`,
        });
      }
      await this.manual.assertSourceLocations(tenantId, [
        { sourceLocationId: dto.sourceLocationId },
      ]);
    }
    // Giữ nguyên người đang phụ trách thì không kiểm lại: đơn cũ có thể giao cho người đã chuyển nơi làm.
    if (dto.assigneeId && dto.assigneeId !== order.assigneeId)
      await this.manual.assertAssignee(
        tenantId,
        dto.assigneeId,
        order.branchId,
      );
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
    const leavingPickup =
      order.fulfillmentType === FulfillmentType.STORE_PICKUP &&
      nextType !== FulfillmentType.STORE_PICKUP;
    if (leavingPickup) assertNoCounterPayment(order.payments);
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
    // Kiểm tra trên kết quả sau khi ghép (giá trị gửi lên đè giá trị đang lưu): trường nào cũng có thể là trường đang bị xoá.
    assertDeliveryInfoComplete(nextType, {
      recipientName:
        dto.recipientName !== undefined
          ? dto.recipientName
          : order.recipientName,
      recipientPhone:
        dto.recipientPhone !== undefined
          ? dto.recipientPhone
          : order.recipientPhone,
      deliveryAddress:
        dto.deliveryAddress !== undefined
          ? dto.deliveryAddress
          : order.deliveryAddress,
    });

    let money: Awaited<ReturnType<OrderEditService['reprice']>> | null = null;
    let grandTotal = Number(order.grandTotal) - storedShipping + shippingFee;
    if (reprice) {
      money = await this.reprice(tenantId, order, dto, topLines, byId);
      grandTotal = money.goodsTotal + shippingFee;
    }

    // Tiền chỉ đổi khi số tiền thật sự đổi (không phải khi client gửi lại đúng giá trị cũ): tổng, phí giao hay cọc. Dòng không cần xét riêng: chỉ sửa được lúc CONFIRMED, khi chưa thể có khoản FULL / BALANCE.
    const depositAmountNow = Number(order.depositAmount ?? 0);
    const moneyChanged =
      shippingFee !== storedShipping ||
      grandTotal !== Number(order.grandTotal) ||
      (dto.deposit !== undefined &&
        (resolveDeposit(dto.deposit, grandTotal)?.amount ?? 0) !==
          depositAmountNow);
    assertEditAllowedByPayments(order.payments, { grandTotal, moneyChanged });

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

    // Chỉ đổi dòng hoặc đổi nguồn hàng mới làm thay đổi nhu cầu trên danh sách sản xuất (B-3).
    const { sourceLocationId } = dto;
    const shortage =
      dto.items || sourceLocationId
        ? await this.shortages.snapshot(tenantId, [
            ...order.items,
            ...(sourceLocationId
              ? order.items.map((line) => ({
                  productItemId: line.productItemId,
                  sourceLocationId,
                  lineType: line.lineType,
                }))
              : []),
            ...(money?.lines ?? []).map((line) => ({
              productItemId: line.productItemId,
              sourceLocationId: line.sourceLocationId,
              lineType: line.itemType,
            })),
            ...addedRows,
          ])
        : null;

    await this.prisma.$transaction(async (tx) => {
      // Khoá đơn trước, đọc lại các khoản rồi kiểm lại luật tiền: một lần thu tiền xen vào giữa lúc đọc và lúc ghi không lọt qua.
      if (!(await lockOrder(tx, tenantId, id))) {
        throw new NotFoundException({
          code: ErrorCode.ORDER_NOT_FOUND,
          message: 'Order not found',
        });
      }
      assertEditAllowedByPayments(
        await tx.payment.findMany({
          where: { orderId: id },
          select: { kind: true, status: true, amount: true },
        }),
        { grandTotal, moneyChanged },
      );
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
      await recordOrderEvents(
        tx,
        userActor(user),
        await this.editEvents(tx, {
          tenantId,
          order,
          dto,
          topLines,
          money,
          deposit,
          nextType,
          customerId,
          shippingFee,
          grandTotal,
        }),
      );
      // Rời luồng khách tới lấy thì mã QR tại quầy không còn hiệu lực: giao tận nơi sẽ thu qua shipper.
      if (leavingPickup) {
        await cancelCounterQr(tx, openCounterQr(order.payments), user.userId);
      }
      // Tổng đơn hay cọc đổi thì trạng thái thanh toán suy lại từ các khoản thật.
      if (moneyChanged) await syncOrderPaymentStatus(tx, id);
      // Dòng không giữ tồn (combo cha, dịch vụ) không có nguồn nên giữ nguyên null.
      if (sourceLocationId) {
        await tx.orderItem.updateMany({
          where: { orderId: id, sourceLocationId: { not: null } },
          data: { sourceLocationId },
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
    if (dto.assigneeId)
      await this.notifyReassigned(tenantId, order, dto.assigneeId, user);
    return this.reads.findOne(user, tenantId, id);
  }

  async setAssignee(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: SetOrderAssigneeDto,
  ) {
    const order = await this.loadEditable(user, tenantId, id, {
      assigneeMayEdit: true,
    });
    const access = assertReassignAccess(user, order);
    if (dto.assigneeId === order.assigneeId)
      return this.reads.findOne(user, tenantId, id);
    await this.manual.assertAssignee(tenantId, dto.assigneeId, order.branchId);
    // Quyền đến từ việc đang phụ trách thì lúc ghi vẫn phải đang phụ trách: hai người cùng giao lại thì người sau thua.
    await this.claimUnshipped(
      user,
      tenantId,
      id,
      { assigneeId: dto.assigneeId },
      (tx) => this.assigneeEvents(tx, tenantId, order, dto.assigneeId),
      assigneeClaim(access, user),
    );
    await this.notifyReassigned(tenantId, order, dto.assigneeId, user);
    return this.reads.findOne(user, tenantId, id);
  }

  /** `GET /orders/:id/assignees`: ai nhận được đơn này, cho ô chọn người phụ trách. Chỉ ai đổi được người phụ trách mới xem được. */
  async listAssignees(user: AuthUser, tenantId: string, id: string) {
    const order = await this.loadEditable(user, tenantId, id, {
      assigneeMayEdit: true,
    });
    assertReassignAccess(user, order);
    const people = await this.manual.listAssignableAt(tenantId, order.branchId);
    return people.map(({ systemRole, ...person }) => ({
      ...toUserRef(person)!,
      isOwner: systemRole === SystemRole.TENANT_OWNER,
      isCurrent: person.id === order.assigneeId,
    }));
  }

  /** Báo người mới và người cũ sau khi đã ghi, trừ chính người vừa đổi. Không bao giờ ném lỗi (`notify` nuốt lỗi). */
  private async notifyReassigned(
    tenantId: string,
    order: { id: string; code: string; assigneeId: string | null },
    nextId: string,
    actor: AuthUser,
  ) {
    if (nextId === order.assigneeId) return;
    if (nextId !== actor.userId) {
      await this.notifications.notify({
        tenantId,
        recipientIds: [nextId],
        referenceId: order.id,
        ...OrderNotificationTemplates.assigned(order.id, order.code),
      });
    }
    if (order.assigneeId && order.assigneeId !== actor.userId) {
      await this.notifications.notify({
        tenantId,
        recipientIds: [order.assigneeId],
        referenceId: order.id,
        ...OrderNotificationTemplates.unassigned(order.id, order.code),
      });
    }
  }

  async setPriority(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: SetOrderPriorityDto,
  ) {
    const order = await this.loadEditable(user, tenantId, id);
    await this.claimUnshipped(
      user,
      tenantId,
      id,
      { priority: dto.priority },
      () =>
        dto.priority === order.priority
          ? []
          : [
              {
                tenantId,
                orderId: id,
                type: OrderEventType.PRIORITY_CHANGED,
                changes: {
                  priority: { from: order.priority, to: dto.priority },
                },
              },
            ],
    );
    return this.reads.findOne(user, tenantId, id);
  }

  /**
   * Đơn nếu người này được sửa lúc này: trong phạm vi quyền, thuộc hành trình và chưa giao.
   * `assigneeMayEdit`: người đang phụ trách được bỏ qua phạm vi chi nhánh (vd. đã chuyển nơi làm sau khi nhận đơn), như các bước khác của đơn.
   */
  private async loadEditable(
    user: AuthUser,
    tenantId: string,
    id: string,
    { assigneeMayEdit = false }: { assigneeMayEdit?: boolean } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        items: true,
        payments: true,
        customer: { select: { name: true } },
        assignee: USER_REF_SELECT,
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
    const asAssignee =
      assigneeMayEdit &&
      order.assigneeId !== null &&
      order.assigneeId === user.userId;
    if (!asAssignee) {
      const scope = this.orders.branchScope(user);
      if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
        throw new ForbiddenException({
          code: ErrorCode.ORDER_BRANCH_DENIED,
          message: 'This order does not belong to your branch',
        });
      }
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

  /** Chỉ đổi các trường được gửi, miễn là đơn chưa bắt đầu giao trong lúc đó. Lệnh chiếm và sự kiện nằm chung một transaction: `events` chỉ chạy sau khi chiếm được. */
  private async claimUnshipped(
    user: AuthUser,
    tenantId: string,
    id: string,
    data: Prisma.OrderUncheckedUpdateManyInput,
    events: (
      tx: Prisma.TransactionClient,
    ) => readonly OrderEventInput[] | Promise<readonly OrderEventInput[]>,
    claim: { assigneeId?: string } = {},
  ) {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id,
          tenantId,
          status: { in: [...UNSHIPPED_ORDER_STATUSES] },
          ...claim,
        },
        data,
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }
      await recordOrderEvents(tx, userActor(user), await events(tx));
    });
  }

  /** Đổi người phụ trách: tên hai người (không phải id) nằm trong `changes` để màn hình hiện thẳng, id nằm trong `metadata`. Không đổi thì không ghi gì. */
  private async assigneeEvents(
    tx: Prisma.TransactionClient,
    tenantId: string,
    order: { id: string; assigneeId: string | null },
    nextId: string,
  ): Promise<OrderEventInput[]> {
    if (nextId === order.assigneeId) return [];
    const names = await displayNamesOf(tx, [order.assigneeId, nextId]);
    return [
      {
        tenantId,
        orderId: order.id,
        type: OrderEventType.ASSIGNEE_CHANGED,
        changes: {
          assignee: {
            from: order.assigneeId
              ? (names.get(order.assigneeId) ?? null)
              : null,
            to: names.get(nextId) ?? null,
          },
        },
        metadata: { fromId: order.assigneeId, toId: nextId },
      },
    ];
  }

  /** Sự kiện của một lần `PATCH /orders/:id`: EDITED (trường + dòng), rồi ASSIGNEE_CHANGED, PRIORITY_CHANGED nếu có. Mọi giá trị trong `changes` là dạng hiển thị được: tên thay cho id, số thay cho Decimal. */
  private async editEvents(
    tx: Prisma.TransactionClient,
    ctx: {
      tenantId: string;
      order: Awaited<ReturnType<OrderEditService['loadEditable']>>;
      dto: UpdateOrderDto;
      topLines: readonly (ExistingLine & {
        productName: string | null;
        sku: string | null;
      })[];
      money: Awaited<ReturnType<OrderEditService['reprice']>> | null;
      deposit: EditedDeposit | null | undefined;
      nextType: string;
      customerId: string | undefined;
      shippingFee: number;
      grandTotal: number;
    },
  ): Promise<OrderEventInput[]> {
    const { tenantId, order, dto, topLines, money, deposit } = ctx;
    const base = { tenantId, orderId: order.id };

    const customerChanged =
      ctx.customerId !== undefined && ctx.customerId !== order.customerId;
    const customer = customerChanged
      ? await tx.customer.findUnique({
          where: { id: ctx.customerId },
          select: { name: true },
        })
      : null;
    const fromSourceId =
      topLines
        .map((line) => sourceOf(line, order.items))
        .find((placeId) => placeId !== null) ?? null;
    const sourceChanged =
      dto.sourceLocationId !== undefined &&
      dto.sourceLocationId !== fromSourceId;
    const places = sourceChanged
      ? await tx.location.findMany({
          where: {
            id: {
              in: [fromSourceId, dto.sourceLocationId].filter(
                (placeId): placeId is string => !!placeId,
              ),
            },
          },
          select: { id: true, name: true },
        })
      : [];
    const placeName = (placeId: string | null | undefined) =>
      places.find((place) => place.id === placeId)?.name ?? null;

    const before: Record<EditField, OrderFieldValue> = {
      recipientName: order.recipientName,
      recipientPhone: order.recipientPhone,
      deliveryAddress: order.deliveryAddress,
      requestedDeliveryDate: order.requestedDeliveryDate,
      note: order.note,
      fulfillmentType: order.fulfillmentType,
      customer: order.customer.name,
      sourceLocation: placeName(fromSourceId),
      shippingFee: order.shippingFee,
      discountType: order.discountType,
      discountValue: order.discountValue,
      depositAmount: order.depositAmount,
      grandTotal: order.grandTotal,
    };
    const after: Partial<Record<EditField, OrderFieldValue>> = {
      recipientName: dto.recipientName,
      recipientPhone: dto.recipientPhone,
      deliveryAddress:
        ctx.nextType === FulfillmentType.STORE_PICKUP &&
        ctx.nextType !== order.fulfillmentType
          ? null
          : dto.deliveryAddress,
      requestedDeliveryDate:
        dto.requestedDeliveryDate === undefined
          ? undefined
          : dto.requestedDeliveryDate
            ? new Date(dto.requestedDeliveryDate)
            : null,
      note: dto.note,
      fulfillmentType: dto.fulfillmentType,
      customer: customerChanged ? (customer?.name ?? null) : undefined,
      sourceLocation: sourceChanged
        ? placeName(dto.sourceLocationId)
        : undefined,
      shippingFee: ctx.shippingFee,
      discountType: money ? money.discountType : undefined,
      discountValue: money ? money.discountValue : undefined,
      depositAmount:
        deposit === undefined ? undefined : (deposit?.amount ?? null),
      grandTotal: ctx.grandTotal,
    };
    const changes = diffOrderFields(before, after, EDIT_FIELDS);

    const lines = dto.items
      ? diffOrderLines(
          topLines.map((line) => ({
            id: line.id,
            name: line.productName ?? line.sku ?? '',
            sku: line.sku ?? '',
            quantity: line.quantity,
            unitPrice: Number(line.unitPrice),
          })),
          (money?.lines ?? []).map((line) => ({
            id: line.id,
            name: line.productName ?? line.sku ?? '',
            sku: line.sku ?? '',
            quantity: line.quantity,
            unitPrice: line.unitPrice,
          })),
        )
      : null;
    const linesChanged =
      lines !== null &&
      lines.added.length + lines.removed.length + lines.changed.length > 0;

    const events: OrderEventInput[] = [];
    if (Object.keys(changes).length > 0 || linesChanged) {
      events.push({
        ...base,
        type: OrderEventType.EDITED,
        changes,
        metadata: linesChanged ? { lines } : undefined,
      });
    }
    if (dto.assigneeId) {
      events.push(
        ...(await this.assigneeEvents(tx, tenantId, order, dto.assigneeId)),
      );
    }
    if (dto.priority && dto.priority !== order.priority) {
      events.push({
        ...base,
        type: OrderEventType.PRIORITY_CHANGED,
        changes: { priority: { from: order.priority, to: dto.priority } },
      });
    }
    return events;
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
          dto.sourceLocationId ??
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
      subtotal: this.pricing.subtotalOf(lines),
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
