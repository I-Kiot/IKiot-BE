import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceService } from '../invoices/invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { OrderService } from '../orders/orders.service';
import { canTransition } from '../orders/order-status';
import {
  ConfirmFailedDeliveryDto,
  CreateOrderReturnDto,
  InspectOrderReturnDto,
  QueryOrderReturnDto,
} from './dto/order-return.dto';
import {
  OrderItemStatus,
  OrderStatus,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import { ShipmentStatus } from '../../common/constants/shipment-status';
import {
  OrderReturnStatus,
  ReturnCondition,
} from '../../common/constants/return-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from '../../common/constants/inventory-ledger';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginate, skipFor } from '../../common/utils/pagination';
import { can } from '../../common/utils/permission';
import {
  REFERENCE_PREFIX,
  generateReference,
} from '../../common/utils/reference-generator';
import type { Prisma } from '../../../generated/prisma/client';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Đơn đã trừ kho (`ship`): chỉ các đơn này mới hoàn về được. */
export const RETURNABLE_ORDER_STATUSES: readonly string[] = [
  OrderStatus.SHIPPING,
  OrderStatus.RECEIVED,
  OrderStatus.COMPLETED,
];

/** Đơn hoàn đã mở nhưng chưa chốt: số lượng của nó đã bị giữ. */
const OPEN_RETURN_STATUSES: readonly string[] = [
  OrderReturnStatus.REQUESTED,
  OrderReturnStatus.INSPECTING,
];

const USER_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
} as const;

const RETURN_INCLUDE = {
  order: {
    select: {
      id: true,
      code: true,
      assigneeId: true,
      customer: { select: { name: true } },
    },
  },
  replacementOrder: { select: { id: true, code: true } },
  createdBy: { select: USER_SELECT },
  inspectedBy: { select: USER_SELECT },
  receivedBy: { select: USER_SELECT },
  items: {
    include: {
      orderItem: { select: { sku: true, productName: true } },
      location: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.OrderReturnInclude;

type ReturnRow = Prisma.OrderReturnGetPayload<{
  include: typeof RETURN_INCLUDE;
}>;

interface UserRow {
  id: string;
  phoneNumber: string;
  profileFirstName: string | null;
  profileLastName: string | null;
}

/** Tên Việt đọc họ trước (`lastName firstName`); tài khoản chưa có tên thì hiện SĐT. */
function toUserRef(user: UserRow | null) {
  if (!user) return null;
  const name = [user.profileLastName, user.profileFirstName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return { id: user.id, name: name || user.phoneNumber };
}

export function toOrderReturn(row: ReturnRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    reason: row.reason,
    order: {
      id: row.order.id,
      code: row.order.code,
      customerName: row.order.customer.name,
      assigneeId: row.order.assigneeId,
    },
    shipmentId: row.shipmentId,
    note: row.note,
    replacementOrder: row.replacementOrder,
    createdBy: toUserRef(row.createdBy),
    receivedBy: toUserRef(row.receivedBy),
    receivedAt: row.receivedAt,
    inspectedBy: toUserRef(row.inspectedBy),
    inspectedAt: row.inspectedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    items: row.items.map((item) => ({
      id: item.id,
      orderItemId: item.orderItemId,
      productName: item.orderItem.productName,
      sku: item.orderItem.sku,
      quantity: item.quantity,
      condition: item.condition,
      location: item.location,
      note: item.note,
    })),
  };
}

/**
 * Hoàn hàng (D-5). Mở tay cho mọi kênh với đơn đã trừ kho. Khi chuyển sang `inspect`, từng dòng đi qua `InventoryService.returnDrawn`: GOOD vào tồn bán được, DAMAGED vào kho hàng hỏng của kho xuất, không bao giờ là tồn bán được.
 */
@Injectable()
export class OrderReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly invoices: InvoiceService,
  ) {}

  async findAll(user: AuthUser, tenantId: string, query: QueryOrderReturnDto) {
    const scope = this.orders.branchScope(user);
    const where: Prisma.OrderReturnWhereInput = {
      tenantId,
      order: { ...scope },
    };
    if (query.status) where.status = query.status;
    if (query.orderId) where.orderId = query.orderId;
    if (query.search) {
      const contains = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { code: contains },
        { order: { code: contains } },
        { order: { customer: { name: contains } } },
        { order: { customer: { phone: contains } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.orderReturn.findMany({
        where,
        include: RETURN_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.orderReturn.count({ where }),
    ]);
    return paginate(rows.map(toOrderReturn), total, query.page, query.limit);
  }

  async findOne(user: AuthUser, tenantId: string, id: string) {
    return toOrderReturn(await this.load(user, tenantId, id));
  }

  /** `POST /order-returns`: tạo ở `REQUESTED`, chưa đụng tồn. */
  async create(
    user: AuthUser,
    tenantId: string,
    dto: CreateOrderReturnDto,
    /** Người gọi đã quyết ai được mở đơn hoàn (`confirmFailedDelivery`) thì truyền cờ này. */
    options: { skipPermission?: boolean } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId },
      include: {
        items: {
          select: {
            id: true,
            status: true,
            lineType: true,
            quantity: true,
            returnedQuantity: true,
            sku: true,
            productName: true,
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
    if (
      !options.skipPermission &&
      !can(user, 'returns', 'create') &&
      order.assigneeId !== user.userId
    ) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_RETURN_DENIED,
        message:
          'Only the order’s person in charge or someone allowed to create returns can open one',
      });
    }
    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw new ConflictException({
        code: ErrorCode.ORDER_RETURN_ORDER_NOT_RETURNABLE,
        message: `An order in ${order.status} has not left stock - cancel it instead of returning it`,
      });
    }

    const ids = dto.items.map((item) => item.orderItemId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_RETURN_EMPTY,
        message: 'A line may appear only once in a return',
      });
    }
    if (dto.shipmentId) {
      const shipment = await this.prisma.shipment.findFirst({
        where: { id: dto.shipmentId, tenantId, orderId: order.id },
        select: { id: true },
      });
      if (!shipment)
        throw new NotFoundException({
          code: ErrorCode.SHIPMENT_NOT_FOUND,
          message: 'Shipment not found on this order',
        });
    }

    // Số lượng mà các đơn hoàn đang mở của đơn này đã giữ: hai nhân viên không được cùng hoàn một đơn vị.
    const reserved = await this.prisma.orderReturnItem.groupBy({
      by: ['orderItemId'],
      where: {
        orderItemId: { in: ids },
        orderReturn: { status: { in: [...OPEN_RETURN_STATUSES] } },
      },
      _sum: { quantity: true },
    });
    const reservedBy = new Map(
      reserved.map((row) => [row.orderItemId, row._sum.quantity ?? 0]),
    );
    const lines = new Map(order.items.map((item) => [item.id, item]));
    for (const item of dto.items) {
      const line = lines.get(item.orderItemId);
      if (
        !line ||
        line.status !== OrderItemStatus.SHIPPED ||
        !STOCKED_LINE_TYPES.includes(line.lineType)
      ) {
        throw new ConflictException({
          code: ErrorCode.ORDER_RETURN_ORDER_NOT_RETURNABLE,
          message: `Line ${item.orderItemId} is not a shipped line of this order`,
        });
      }
      const left =
        line.quantity - line.returnedQuantity - (reservedBy.get(line.id) ?? 0);
      if (item.quantity > left) {
        throw new ConflictException({
          code: ErrorCode.ORDER_RETURN_QTY_EXCEEDS,
          message: `Cannot return ${item.quantity} of ${line.sku ?? line.productName ?? line.id}: only ${Math.max(left, 0)} left to return`,
        });
      }
    }

    const created = await this.prisma.orderReturn.create({
      data: {
        tenantId,
        code: generateReference(REFERENCE_PREFIX.ORDER_RETURN),
        orderId: order.id,
        shipmentId: dto.shipmentId ?? null,
        reason: dto.reason,
        status: OrderReturnStatus.REQUESTED,
        note: dto.note ?? null,
        createdById: user.userId,
        items: {
          create: dto.items.map((item) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
            note: item.note ?? null,
          })),
        },
      },
      select: { id: true },
    });
    return this.findOne(user, tenantId, created.id);
  }

  /** `POST /order-returns/:id/receive`: hàng đã về shop. `REQUESTED` → `INSPECTING`. */
  async receive(user: AuthUser, tenantId: string, id: string) {
    await this.load(user, tenantId, id);
    const claimed = await this.prisma.orderReturn.updateMany({
      where: { id, tenantId, status: OrderReturnStatus.REQUESTED },
      data: {
        status: OrderReturnStatus.INSPECTING,
        receivedById: user.userId,
        receivedAt: new Date(),
      },
    });
    if (claimed.count !== 1) this.statusInvalid('received', 'REQUESTED');
    return this.findOne(user, tenantId, id);
  }

  /**
   * `POST /order-returns/confirm-failed-delivery`: hàng của lần giao thất bại đã về shop. Một lần bấm mở đơn hoàn
   * DELIVERY_FAILED cho mọi dòng còn ở ngoài, nhận và kiểm luôn, nên tồn về lại, đơn → RETURNED và shipment → RETURNED
   * trong một transaction. Trước đó shipment thất bại vẫn đang trên đường (shipper có thể giao lại), nên `fail` không làm việc này.
   * Dòng về GOOD tại nơi đã xuất, trừ khi `items` ghi khác.
   */
  async confirmFailedDelivery(
    user: AuthUser,
    tenantId: string,
    dto: ConfirmFailedDeliveryDto,
  ) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: dto.shipmentId, tenantId },
      select: {
        id: true,
        status: true,
        order: {
          select: {
            id: true,
            branchId: true,
            assigneeId: true,
            status: true,
            items: {
              select: {
                id: true,
                status: true,
                lineType: true,
                quantity: true,
                returnedQuantity: true,
              },
            },
          },
        },
      },
    });
    if (!shipment)
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    const { order } = shipment;
    const scope = this.orders.branchScope(user);
    if (scope.branchId !== undefined && order.branchId !== scope.branchId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_BRANCH_DENIED,
        message: 'This order does not belong to your branch',
      });
    }
    if (!can(user, 'orders', 'read') && order.assigneeId !== user.userId) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_RETURN_DENIED,
        message:
          'Only the order’s person in charge or someone who can view the order can confirm the goods are back',
      });
    }
    if (
      shipment.status !== ShipmentStatus.FAILED ||
      order.status !== OrderStatus.SHIPPING
    ) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: `Only a failed delivery of a SHIPPING order can be confirmed returned (shipment ${shipment.status}, order ${order.status})`,
      });
    }

    const lines = order.items
      .filter(
        (item) =>
          item.status === OrderItemStatus.SHIPPED &&
          STOCKED_LINE_TYPES.includes(item.lineType) &&
          item.quantity - item.returnedQuantity > 0,
      )
      .map((item) => ({
        orderItemId: item.id,
        quantity: item.quantity - item.returnedQuantity,
      }));
    if (lines.length === 0) {
      throw new ConflictException({
        code: ErrorCode.ORDER_RETURN_ORDER_NOT_RETURNABLE,
        message: 'There is nothing left on this order to bring back',
      });
    }

    const created = await this.create(
      user,
      tenantId,
      {
        orderId: order.id,
        reason: 'DELIVERY_FAILED',
        shipmentId: shipment.id,
        note: dto.note,
        items: lines,
      },
      { skipPermission: true },
    );
    const received = await this.prisma.orderReturn.updateMany({
      where: { id: created.id, tenantId, status: OrderReturnStatus.REQUESTED },
      data: {
        status: OrderReturnStatus.INSPECTING,
        receivedById: user.userId,
        receivedAt: new Date(),
      },
    });
    if (received.count !== 1) this.statusInvalid('received', 'REQUESTED');

    const verdicts = new Map(
      (dto.items ?? []).map((item) => [item.orderItemId, item]),
    );
    return this.inspect(
      user,
      tenantId,
      created.id,
      {
        items: lines.map((line) => ({
          ...verdicts.get(line.orderItemId),
          orderItemId: line.orderItemId,
          condition:
            verdicts.get(line.orderItemId)?.condition ?? ReturnCondition.GOOD,
        })),
      },
      async (tx) => {
        const closed = await tx.shipment.updateMany({
          where: { id: shipment.id, status: ShipmentStatus.FAILED },
          data: { status: ShipmentStatus.RETURNED },
        });
        if (closed.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.SHIPMENT_STATUS_INVALID,
            message: 'The shipment has just changed, please reload',
          });
        }
        await tx.shipmentEvent.create({
          data: {
            shipmentId: shipment.id,
            status: ShipmentStatus.RETURNED,
            source: 'MANUAL',
            note: dto.note ?? null,
            createdById: user.userId,
          },
        });
      },
    );
  }

  /** `POST /order-returns/:id/cancel`: chỉ trước khi hàng được đưa về, nên tồn chưa bị đụng tới. */
  async cancel(user: AuthUser, tenantId: string, id: string) {
    await this.load(user, tenantId, id);
    const claimed = await this.prisma.orderReturn.updateMany({
      where: { id, tenantId, status: { in: [...OPEN_RETURN_STATUSES] } },
      data: { status: OrderReturnStatus.CANCELLED },
    });
    if (claimed.count !== 1)
      this.statusInvalid('cancelled', 'REQUESTED or INSPECTING');
    return this.findOne(user, tenantId, id);
  }

  /**
   * `POST /order-returns/:id/inspect`: mỗi dòng có một kết luận và đi qua `returnDrawn` trong một transaction.
   * Dòng bị từ chối (không có kho hàng hỏng, kho không bán được) thì không đưa gì về. Đơn hoàn và đơn gốc được khoá ngay khi đọc trạng thái.
   */
  async inspect(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: InspectOrderReturnDto,
    /** Chạy trong transaction chốt, nên ghi của người gọi lên cùng hoặc không lên gì. */
    within?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const orderReturn = await this.load(user, tenantId, id);
    if (orderReturn.status !== OrderReturnStatus.INSPECTING) {
      this.statusInvalid('inspected', 'INSPECTING - receive the goods first');
    }

    const verdicts = new Map(dto.items.map((item) => [item.orderItemId, item]));
    const missing = orderReturn.items.filter(
      (item) => !verdicts.get(item.orderItemId)?.condition,
    );
    if (missing.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_RETURN_CONDITION_REQUIRED,
        message: `Every line needs a condition (GOOD or DAMAGED); missing for ${missing
          .map(
            (item) =>
              item.orderItem.sku ??
              item.orderItem.productName ??
              item.orderItemId,
          )
          .join(', ')}`,
      });
    }
    const known = new Set(orderReturn.items.map((item) => item.orderItemId));
    const stray = dto.items.filter((item) => !known.has(item.orderItemId));
    if (stray.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_RETURN_CONDITION_REQUIRED,
        message: `Lines not part of this return: ${stray.map((item) => item.orderItemId).join(', ')}`,
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.orderReturn.updateMany({
        where: { id, tenantId, status: OrderReturnStatus.INSPECTING },
        data: {
          status: OrderReturnStatus.COMPLETED,
          inspectedById: user.userId,
          inspectedAt: now,
          completedAt: now,
        },
      });
      if (claimed.count !== 1) this.statusInvalid('inspected', 'INSPECTING');

      for (const line of orderReturn.items) {
        const verdict = verdicts.get(line.orderItemId)!;
        const item = await tx.orderItem.findUniqueOrThrow({
          where: { id: line.orderItemId },
          select: { productItemId: true, quantity: true },
        });
        const label =
          line.orderItem.sku ?? line.orderItem.productName ?? line.orderItemId;
        const origin = await this.shippedFrom(tx, tenantId, line.orderItemId);
        const condition = verdict.condition as ReturnCondition;
        const toLocationId = await this.destination(
          tx,
          tenantId,
          condition,
          verdict.locationId,
          origin,
          label,
        );

        await this.inventory.returnDrawn(tx, {
          tenantId,
          productItemId: item.productItemId,
          toLocationId,
          quantity: line.quantity,
          drawnBy: { orderItemId: line.orderItemId },
          ledger: {
            type:
              condition === ReturnCondition.GOOD
                ? InventoryTxType.RETURN_GOOD
                : InventoryTxType.RETURN_DAMAGED,
            referenceType: InventoryRefType.ORDER_RETURN,
            referenceId: id,
            createdById: user.userId,
            note: verdict.note ?? line.note ?? null,
          },
          // Bán trước khi hàng có lot: không có gì để lần ngược, nên hoàn thành một lot mới.
          ifNeverDrawn: { sourceType: LotSourceType.OPENING },
        });

        // Có điều kiện theo số lượng: hai đơn hoàn chốt cùng dòng không thể đẩy số hoàn vượt số đã bán.
        const bumped = await tx.orderItem.updateMany({
          where: {
            id: line.orderItemId,
            returnedQuantity: { lte: item.quantity - line.quantity },
          },
          data: { returnedQuantity: { increment: line.quantity } },
        });
        if (bumped.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_RETURN_QTY_EXCEEDS,
            message: `Returning ${line.quantity} of ${label} would exceed what was sold`,
          });
        }
        await tx.orderItem.updateMany({
          where: {
            id: line.orderItemId,
            returnedQuantity: item.quantity,
            status: OrderItemStatus.SHIPPED,
          },
          data: { status: OrderItemStatus.RETURNED },
        });
        await tx.orderReturnItem.update({
          where: { id: line.id },
          data: {
            condition,
            locationId: toLocationId,
            note: verdict.note ?? line.note ?? null,
          },
        });
      }

      await this.settleOrder(tx, tenantId, orderReturn.order.id);
      await within?.(tx);
      // Hoá đơn đã xuất thì hàng hoàn là điều chỉnh theo giá trị (hoá đơn PENDING sẽ tự trừ khi xuất).
      await this.invoices.adjustForReturn(
        tx,
        orderReturn.order.id,
        `Hoàn hàng ${orderReturn.code}`,
        user.userId,
        orderReturn.items.map((line) => ({
          orderItemId: line.orderItemId,
          quantity: line.quantity,
        })),
      );
    });

    return this.findOne(user, tenantId, id);
  }

  /** `PATCH /order-returns/:id/replacement-order`: gắn đơn khách đặt để mua lại hàng. */
  async setReplacementOrder(
    user: AuthUser,
    tenantId: string,
    id: string,
    replacementOrderId: string,
  ) {
    const orderReturn = await this.load(user, tenantId, id);
    if (replacementOrderId === orderReturn.order.id) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_RETURN_STATUS_INVALID,
        message: 'A replacement order cannot be the returned order itself',
      });
    }
    const replacement = await this.prisma.order.findFirst({
      where: { id: replacementOrderId, tenantId },
      select: { id: true },
    });
    if (!replacement)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Replacement order not found',
      });
    await this.prisma.orderReturn.update({
      where: { id },
      data: { replacementOrderId },
    });
    return this.findOne(user, tenantId, id);
  }

  /** Đơn hoàn khác tenant hoặc khác chi nhánh đều 404 (contract §0). */
  private async load(user: AuthUser, tenantId: string, id: string) {
    const scope = this.orders.branchScope(user);
    const row = await this.prisma.orderReturn.findFirst({
      where: { id, tenantId, order: { ...scope } },
      include: RETURN_INCLUDE,
    });
    if (!row)
      throw new NotFoundException({
        code: ErrorCode.ORDER_RETURN_NOT_FOUND,
        message: 'Order return not found',
      });
    return row;
  }

  private statusInvalid(action: string, needs: string): never {
    throw new ConflictException({
      code: ErrorCode.ORDER_RETURN_STATUS_INVALID,
      message: `This return cannot be ${action} in its current status (needs ${needs})`,
    });
  }

  /** Hàng của dòng xuất từ đâu: dòng SALE trong sổ ghi đúng nơi đó; đơn bán trước khi có lot thì dùng nguồn dự kiến của dòng. */
  private async shippedFrom(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderItemId: string,
  ): Promise<string | null> {
    const out = await tx.inventoryTransaction.findFirst({
      where: {
        tenantId,
        orderItemId,
        type: InventoryTxType.SALE,
        quantity: { lt: 0 },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { locationId: true },
    });
    if (out) return out.locationId;
    const item = await tx.orderItem.findUnique({
      where: { id: orderItemId },
      select: { sourceLocationId: true },
    });
    return item?.sourceLocationId ?? null;
  }

  /** GOOD → kho được chỉ định (hoặc kho xuất), kho đó phải bán được. DAMAGED → kho hàng hỏng của kho xuất. */
  private async destination(
    tx: Prisma.TransactionClient,
    tenantId: string,
    condition: ReturnCondition,
    requested: string | undefined,
    origin: string | null,
    label: string,
  ): Promise<string> {
    if (condition === ReturnCondition.DAMAGED) {
      const from = origin
        ? await tx.location.findFirst({
            where: { id: origin, tenantId },
            select: { damagedLocationId: true },
          })
        : null;
      if (!from?.damagedLocationId) {
        throw new ConflictException({
          code: ErrorCode.LOCATION_DAMAGED_REQUIRED,
          message: `${label} came back damaged but the location it shipped from has no damaged-goods warehouse set`,
        });
      }
      return from.damagedLocationId;
    }

    const locationId = requested ?? origin;
    if (!locationId) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_REQUIRED,
        message: `Say which location ${label} goes back to - it has no recorded shipping location`,
      });
    }
    const target = await tx.location.findFirst({
      where: { id: locationId, tenantId },
      select: { isSellable: true },
    });
    if (!target)
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: 'Location not found',
      });
    if (!target.isSellable) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_NOT_SELLABLE,
        message: `${label} came back in good condition; a damaged-goods location cannot take it`,
      });
    }
    return locationId;
  }

  /** Đơn → RETURNED khi mọi dòng đã trừ kho được hoàn đủ; hoàn một phần thì đơn giữ nguyên. */
  private async settleOrder(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const order = await tx.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        status: true,
        items: { select: { status: true, lineType: true } },
      },
    });
    if (!order) return;
    const stocked = order.items.filter(
      (item) =>
        STOCKED_LINE_TYPES.includes(item.lineType) &&
        (item.status === OrderItemStatus.SHIPPED ||
          item.status === OrderItemStatus.RETURNED),
    );
    const allBack =
      stocked.length > 0 &&
      stocked.every((item) => item.status === OrderItemStatus.RETURNED);
    if (allBack && canTransition(order.status, OrderStatus.RETURNED)) {
      await tx.order.updateMany({
        where: { id: orderId, tenantId, status: order.status },
        data: { status: OrderStatus.RETURNED },
      });
      // Hoàn đủ trước khi đơn kịp hoàn thành: chưa xuất hoá đơn nên rút hoá đơn PENDING.
      await this.invoices.voidPending(tx, orderId);
    }
  }
}
