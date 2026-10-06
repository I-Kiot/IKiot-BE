import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { NotificationService } from '../notifications/notifications.service';
import { ShipmentNotificationTemplates } from '../notifications/templates/shipment.templates';
import { assertTransition } from '../orders/order-status';
import {
  assertOrderStepAccess,
  assigneeClaim,
  OrderStepPermission,
} from '../orders/order-handler';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { ChangeDriverDto } from './dto/change-driver.dto';
import { ShipOrderDto } from './dto/ship-order.dto';
import {
  OrderItemStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import {
  CarrierType,
  FINAL_SHIPMENT_STATUSES,
  ShipmentEventSource,
  ShipmentStatus,
} from '../../common/constants/shipment-status';
import {
  InventoryRefType,
  InventoryTxType,
} from '../../common/constants/inventory-ledger';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { ErrorCode } from '../../common/errors/error-codes';
import { withNestedProfile } from '../../common/utils/user-profile';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Quyền theo role để làm shipper / thợ giao hàng. */
const DRIVER_PERMISSION = { resource: 'shipments', action: 'deliver' } as const;

/** Một người trong payload: `{ id, phoneNumber, profile }` như mọi chỗ khác (`withNestedProfile`). */
const PERSON_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  profileAvatarUrl: true,
} as const;

/** Đủ để dựng `Shipment` của contract §4. */
const SHIPMENT_DETAIL_INCLUDE = {
  order: {
    select: {
      id: true,
      code: true,
      status: true,
      grandTotal: true,
      depositAmount: true,
      customer: { select: { name: true } },
    },
  },
  driver: { select: PERSON_SELECT },
  events: {
    orderBy: { occurredAt: 'asc' },
    include: { createdBy: { select: PERSON_SELECT } },
  },
} as const;

/** Số shipper thu khi giao = tổng đơn − tiền cọc (schema: tính chứ không lưu). */
export function amountDueOf(order: {
  grandTotal: unknown;
  depositAmount: unknown;
}): number {
  return Number(order.grandTotal) - Number(order.depositAmount ?? 0);
}

/**
 * Lấy hàng & giao hàng (C-2, C-8): ghi nhận "ĐVVC đã lấy hàng", đổi shipper, và chuyển đơn sang
 * Đang vận chuyển – bước trừ tồn kho. Ai được làm mỗi bước do `assertOrderStepAccess` quyết định:
 * chủ shop, người phụ trách đơn, hoặc người có quyền của bước đó tại kho của fulfillment.
 */
@Injectable()
export class ShipmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationService,
  ) {}

  /** PACKED → PICKED_UP (GĐ1–B6.1): tạo shipment, fulfillment sang HANDED_OVER. Tồn kho không đổi – hàng vẫn đang khoá. */
  async create(user: AuthUser, tenantId: string, dto: CreateShipmentDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId },
      select: {
        id: true,
        code: true,
        status: true,
        assigneeId: true,
        recipientName: true,
        recipientPhone: true,
        deliveryAddress: true,
        fulfillments: {
          where: { status: FulfillmentStatus.PACKED },
          select: { id: true, locationId: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    const [fulfillment] = order.fulfillments;
    if (order.status !== OrderStatus.PACKED || !fulfillment) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_ORDER_NOT_PACKED,
        message: 'Only a packed order can be handed to a carrier',
      });
    }
    const access = assertOrderStepAccess(
      user,
      order,
      OrderStepPermission.HAND_OVER,
      fulfillment.locationId,
    );

    if (dto.carrierType === CarrierType.INTERNAL && !dto.driverId) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DRIVER_REQUIRED,
        message: 'An internal delivery needs a driver',
      });
    }
    if (dto.carrierType === CarrierType.EXTERNAL && dto.driverId) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DRIVER_NOT_ALLOWED,
        message: 'A third-party carrier delivery has no driver of ours',
      });
    }
    if (dto.driverId) {
      await this.assertEligibleDriver(tenantId, dto.driverId, order);
    }
    await this.assertTrackingFree(dto.carrierName, dto.trackingCode);

    const now = new Date();
    const shipmentId = await this.prisma.$transaction(async (tx) => {
      // Nhận đơn theo trạng thái đã đọc: hai người cùng bấm thì một người nhận 409, không có hai shipment.
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          tenantId,
          status: OrderStatus.PACKED,
          ...assigneeClaim(access, user),
        },
        data: { status: OrderStatus.PICKED_UP },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }
      await tx.fulfillment.updateMany({
        where: { id: fulfillment.id, status: FulfillmentStatus.PACKED },
        data: { status: FulfillmentStatus.HANDED_OVER, handedOverAt: now },
      });
      const shipment = await tx.shipment.create({
        data: {
          tenantId,
          orderId: order.id,
          fulfillmentId: fulfillment.id,
          carrierType: dto.carrierType,
          carrierName: dto.carrierName ?? null,
          trackingCode: dto.trackingCode ?? null,
          driverId: dto.driverId ?? null,
          status: ShipmentStatus.PICKED_UP,
          recipientName: order.recipientName,
          recipientPhone: order.recipientPhone,
          deliveryAddress: order.deliveryAddress,
          scheduledDate: dto.scheduledDate
            ? new Date(`${dto.scheduledDate.slice(0, 10)}T00:00:00Z`)
            : null,
          scheduledSlot: dto.scheduledSlot ?? null,
          requiresInstallation: dto.requiresInstallation ?? false,
          shippingCost: dto.shippingCost ?? null,
          note: dto.note ?? null,
          events: {
            create: {
              status: ShipmentStatus.PICKED_UP,
              source: ShipmentEventSource.MANUAL,
              note: dto.note ?? null,
              createdById: user.userId,
            },
          },
        },
        select: { id: true },
      });
      return shipment.id;
    });

    // Sau commit: shipment rollback thì không có thông báo nào.
    await this.notifyDriver(
      tenantId,
      dto.driverId,
      user,
      shipmentId,
      order.code,
    );
    return this.findDetail(tenantId, shipmentId);
  }

  /** Đổi shipper / thợ của shipment INTERNAL chưa kết thúc (C-8). */
  async changeDriver(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: ChangeDriverDto,
  ) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        carrierType: true,
        driverId: true,
        fulfillment: { select: { locationId: true } },
        order: { select: { id: true, code: true, assigneeId: true } },
      },
    });
    if (!shipment) {
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    }
    const access = assertOrderStepAccess(
      user,
      shipment.order,
      OrderStepPermission.CHANGE_DRIVER,
      shipment.fulfillment.locationId,
    );
    if (shipment.carrierType !== CarrierType.INTERNAL) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DRIVER_NOT_ALLOWED,
        message: 'A third-party carrier delivery has no driver of ours',
      });
    }
    if (FINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: `A ${shipment.status} shipment cannot change driver`,
      });
    }
    if (shipment.driverId === dto.driverId) {
      return this.findDetail(tenantId, id);
    }
    await this.assertEligibleDriver(tenantId, dto.driverId, shipment.order);

    // Ghi có điều kiện: shipment vừa kết thúc, hoặc người gọi vừa thôi phụ trách đơn, thì không ghi.
    const updated = await this.prisma.shipment.updateMany({
      where: {
        id,
        tenantId,
        status: { notIn: [...FINAL_SHIPMENT_STATUSES] },
        ...(access === 'ASSIGNEE'
          ? { order: { assigneeId: user.userId } }
          : {}),
      },
      data: { driverId: dto.driverId },
    });
    if (updated.count !== 1) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: 'The shipment has just changed, please reload',
      });
    }

    await this.notifyDriver(
      tenantId,
      dto.driverId,
      user,
      id,
      shipment.order.code,
    );
    return this.findDetail(tenantId, id);
  }

  /**
   * PICKED_UP → SHIPPING (GĐ1–B6.2–3): bước trừ tồn kho. Hàng đã khoá lúc đóng gói, nên trừ cả `stock`
   * lẫn `locked_stock` theo đúng chứng từ khoá – các dòng của fulfillment đã bàn giao – giống A-5 trả
   * khoá theo đúng các dòng đó. Không gọi `notifyLowStock`: hàng trên kệ không đổi, nên không có ngưỡng
   * nào mới bị vượt.
   */
  async shipOrder(
    user: AuthUser,
    tenantId: string,
    orderId: string,
    dto: ShipOrderDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        status: true,
        assigneeId: true,
        fulfillments: {
          where: { status: FulfillmentStatus.HANDED_OVER },
          select: {
            id: true,
            locationId: true,
            items: {
              select: {
                quantity: true,
                orderItemId: true,
                orderItem: {
                  select: { productItemId: true, sku: true, productName: true },
                },
              },
            },
          },
        },
        shipments: {
          where: { status: ShipmentStatus.PICKED_UP },
          select: { id: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }
    // Chỉ để báo lỗi sớm; chỗ chặn thật là bước nhận đơn trong transaction.
    assertTransition(order.status, OrderStatus.SHIPPING);
    const [fulfillment] = order.fulfillments;
    const [shipment] = order.shipments;
    if (!fulfillment || !shipment) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_FULFILLMENT_NOT_HANDED_OVER,
        message: 'The order has no handed-over fulfillment and open shipment',
      });
    }
    const access = assertOrderStepAccess(
      user,
      order,
      OrderStepPermission.SHIP,
      fulfillment.locationId,
    );

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id: orderId,
          tenantId,
          status: OrderStatus.PICKED_UP,
          ...assigneeClaim(access, user),
        },
        data: {
          status: OrderStatus.SHIPPING,
          shippedById: user.userId,
          shippedAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: ErrorCode.ORDER_STATUS_CONFLICT,
          message: 'The order has just changed, please reload',
        });
      }

      // Một câu UPDATE có điều kiện cho mỗi dòng (locked_stock ≥ quantity) – chính câu đó là chốt chặn, không gom được thành một query.
      for (const item of fulfillment.items) {
        await this.inventory.shipLockedStock(tx, {
          tenantId,
          locationId: fulfillment.locationId,
          productItemId: item.orderItem.productItemId,
          quantity: item.quantity,
          label:
            item.orderItem.sku ??
            item.orderItem.productName ??
            item.orderItemId,
          ledger: {
            type: InventoryTxType.SALE,
            referenceType: InventoryRefType.ORDER,
            referenceId: orderId,
            orderItemId: item.orderItemId,
            createdById: user.userId,
          },
        });
      }
      // Chỉ các dòng có hàng đã trừ mới SHIPPED; dòng COMBO cha / dịch vụ không có tồn để trừ.
      await tx.orderItem.updateMany({
        where: {
          id: { in: fulfillment.items.map((item) => item.orderItemId) },
          status: OrderItemStatus.PENDING,
        },
        data: { status: OrderItemStatus.SHIPPED },
      });
      await tx.shipment.updateMany({
        where: { id: shipment.id, status: ShipmentStatus.PICKED_UP },
        data: { status: ShipmentStatus.IN_TRANSIT },
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: shipment.id,
          status: ShipmentStatus.IN_TRANSIT,
          source: ShipmentEventSource.MANUAL,
          note: dto.note ?? null,
          createdById: user.userId,
        },
      });
    });

    return this.findDetail(tenantId, shipment.id);
  }

  /**
   * Ai được làm shipper của đơn này: chủ shop, người phụ trách đơn (toàn quyền với đơn của mình), hoặc
   * STAFF đang hoạt động có `shipments:deliver` trong role. Quyền trưởng ca không tính – nó hết theo giờ,
   * còn việc giao hàng kéo dài qua ca.
   */
  private async assertEligibleDriver(
    tenantId: string,
    driverId: string,
    order: { assigneeId: string | null },
  ) {
    const driver = await this.prisma.user.findFirst({
      where: { id: driverId, tenantId, status: UserStatus.ACTIVE },
      select: {
        id: true,
        systemRole: true,
        role: {
          select: {
            permissions: {
              where: DRIVER_PERMISSION,
              select: { action: true },
            },
          },
        },
      },
    });
    const eligible =
      driver !== null &&
      (driver.systemRole === SystemRole.TENANT_OWNER ||
        driver.id === order.assigneeId ||
        (driver.systemRole === SystemRole.STAFF &&
          (driver.role?.permissions.length ?? 0) > 0));
    if (!eligible) {
      throw new BadRequestException({
        code: ErrorCode.SHIPMENT_DRIVER_INVALID,
        message:
          "The driver must be the shop owner, the order's person in charge, or an active staff member who can deliver",
      });
    }
  }

  /** Báo trước khi tạo cho đẹp; ràng buộc `@@unique([carrierName, trackingCode])` vẫn là chốt chặn cuối (P2002 → 409 qua filter chung). Ràng buộc chỉ có hiệu lực khi có cả hai giá trị, nên kiểm tra cũng vậy. */
  private async assertTrackingFree(
    carrierName: string | undefined,
    trackingCode: string | undefined,
  ) {
    if (!carrierName || !trackingCode) return;
    const taken = await this.prisma.shipment.findFirst({
      where: { carrierName, trackingCode },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_TRACKING_TAKEN,
        message: 'This tracking code is already on another shipment',
      });
    }
  }

  /** Báo cho người vừa được gán giao hàng, trừ khi họ tự gán chính mình. Không bao giờ ném lỗi (`notify` nuốt lỗi). */
  private async notifyDriver(
    tenantId: string,
    driverId: string | undefined,
    actor: AuthUser,
    shipmentId: string,
    orderCode: string,
  ) {
    if (!driverId || driverId === actor.userId) return;
    await this.notifications.notify({
      tenantId,
      recipientIds: [driverId],
      referenceId: shipmentId,
      ...ShipmentNotificationTemplates.assigned(shipmentId, orderCode),
    });
  }

  /** Shipment theo hình dạng của contract §4. */
  private async findDetail(tenantId: string, id: string) {
    const shipment = await this.prisma.shipment.findFirstOrThrow({
      where: { id, tenantId },
      include: SHIPMENT_DETAIL_INCLUDE,
    });
    const { order, driver, events, ...rest } = shipment;
    return {
      ...rest,
      shippingCost:
        rest.shippingCost === null ? null : Number(rest.shippingCost),
      order: {
        id: order.id,
        code: order.code,
        status: order.status,
        customerName: order.customer.name,
        amountDue: amountDueOf(order),
      },
      driver: driver ? withNestedProfile(driver) : null,
      events: events.map(({ createdBy, ...event }) => ({
        ...event,
        createdBy: createdBy ? withNestedProfile(createdBy) : null,
      })),
    };
  }
}
