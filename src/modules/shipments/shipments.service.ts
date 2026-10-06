import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { NotificationService } from '../notifications/notifications.service';
import { ShipmentNotificationTemplates } from '../notifications/templates/shipment.templates';
import { assertTransition } from '../orders/order-status';
import {
  assertOrderStepAccess,
  assigneeClaim,
  orderStepAccess,
  OrderStepPermission,
} from '../orders/order-handler';
import {
  loadShipmentDetail,
  PERSON_SELECT,
  SHIPMENT_SUMMARY_INCLUDE,
  toSummary,
} from './shipment-view';
import {
  ON_THE_ROAD_STATUSES,
  onTheRoadWhere,
  trackingActorAccess,
  type ShipmentActorAccess,
} from './shipment-actor';
import { businessDayRange } from '../cash-drawer-sessions/business-date';
import { CreateShipmentDto } from './dto/create-shipment.dto';
import { ChangeDriverDto } from './dto/change-driver.dto';
import { ShipOrderDto } from './dto/ship-order.dto';
import { QueryShipmentDto } from './dto/query-shipment.dto';
import { AddShipmentEventDto } from './dto/add-shipment-event.dto';
import { FailShipmentDto } from './dto/fail-shipment.dto';
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
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { ErrorCode } from '../../common/errors/error-codes';
import { can } from '../../common/utils/permission';
import { paginate } from '../../common/utils/pagination';
import { withNestedProfile } from '../../common/utils/user-profile';
import type { AuthUser } from '../../common/types/auth-user.type';

/** Quyền theo role để làm shipper / thợ giao hàng. */
const DRIVER_PERMISSION = { resource: 'shipments', action: 'deliver' } as const;

/**
 * Lấy hàng & giao hàng: ghi nhận "ĐVVC đã lấy hàng", đổi shipper, chuyển đơn sang Đang vận chuyển –
 * bước trừ tồn kho (C-2, C-8); xem danh sách / chi tiết, ghi nhật trình, báo giao không thành (C-3).
 * Ai được làm mỗi bước do `assertOrderStepAccess` quyết định: chủ shop, người phụ trách đơn, hoặc
 * người có quyền của bước đó tại kho của fulfillment; nhật trình và báo thất bại thêm shipper.
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

  /** Shipper được chọn phải nằm trong `eligibleDriverWhere` của đơn. */
  private async assertEligibleDriver(
    tenantId: string,
    driverId: string,
    order: { assigneeId: string | null },
  ) {
    const driver = await this.prisma.user.findFirst({
      where: { AND: [eligibleDriverWhere(tenantId, order), { id: driverId }] },
      select: { id: true },
    });
    if (!driver) {
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

  /** Shipment theo hình dạng của contract §4 – `loadShipmentDetail`, dùng chung với ShipmentDeliveryService. */
  private findDetail(tenantId: string, id: string) {
    return loadShipmentDetail(this.prisma, tenantId, id);
  }

  // ─── Chọn shipper (C-9) ─────────────────────────────────────────────────────

  /**
   * GET /shipments/drivers?orderId=: những người làm shipper được cho đơn này, cho ô chọn shipper. Chỉ
   * người sắp chọn shipper mới thấy danh sách nhân viên – người được giao hàng (HAND_OVER) hoặc đổi
   * shipper (CHANGE_DRIVER) cho đơn, tại kho của fulfillment.
   */
  async listDrivers(user: AuthUser, tenantId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        assigneeId: true,
        fulfillments: {
          where: {
            status: {
              in: [FulfillmentStatus.PACKED, FulfillmentStatus.HANDED_OVER],
            },
          },
          select: { locationId: true },
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
    if (!fulfillment) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_ORDER_NOT_PACKED,
        message: 'Only a packed order has drivers to choose from',
      });
    }
    const canChoose =
      orderStepAccess(
        user,
        order,
        OrderStepPermission.HAND_OVER,
        fulfillment.locationId,
      ) ??
      orderStepAccess(
        user,
        order,
        OrderStepPermission.CHANGE_DRIVER,
        fulfillment.locationId,
      );
    if (!canChoose) {
      throw new ForbiddenException({
        code: ErrorCode.ORDER_STEP_DENIED,
        message:
          "Only the shop owner, the order's person in charge, or someone who can hand over or reassign this order at this location can list its drivers",
      });
    }

    const drivers = await this.prisma.user.findMany({
      where: eligibleDriverWhere(tenantId, order),
      select: { ...PERSON_SELECT, systemRole: true },
      orderBy: [{ profileFirstName: 'asc' }, { phoneNumber: 'asc' }],
    });
    return drivers.map((driver) => ({
      ...withNestedProfile(driver),
      isAssignee: driver.id === order.assigneeId,
    }));
  }

  // ─── Đọc & nhật trình (C-3) ─────────────────────────────────────────────────

  /** GET /shipments: các shipment người gọi được xem (`visibleWhere`), mới nhất trước. */
  async findAll(user: AuthUser, tenantId: string, query: QueryShipmentDto) {
    const where: Prisma.ShipmentWhereInput = {
      AND: [
        this.visibleWhere(user, tenantId),
        {
          ...(query.status ? { status: query.status } : {}),
          ...(query.carrierType ? { carrierType: query.carrierType } : {}),
          ...(query.driverId ? { driverId: query.driverId } : {}),
          ...createdWithin(query.from, query.to),
        },
        query.search ? searchWhere(query.search) : {},
      ],
    };
    const [total, rows] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({
        where,
        include: SHIPMENT_SUMMARY_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
    ]);
    return paginate(rows.map(toSummary), total, query.page, query.limit);
  }

  /** GET /shipments/:id: ngoài phạm vi xem thì 404 – như không tồn tại. */
  async findOne(user: AuthUser, tenantId: string, id: string) {
    const visible = await this.prisma.shipment.findFirst({
      where: { AND: [this.visibleWhere(user, tenantId), { id }] },
      select: { id: true },
    });
    if (!visible) {
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    }
    return this.findDetail(tenantId, id);
  }

  /** POST /shipments/:id/events: nhật trình chỉ mang OUT_FOR_DELIVERY và đẩy shipment sang "Đang đi giao". Không đổi trạng thái đơn. */
  async addEvent(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: AddShipmentEventDto,
  ) {
    const shipment = await this.loadOnTheRoad(user, tenantId, id);
    await this.prisma.$transaction(async (tx) => {
      await this.claimOnTheRoad(tx, shipment, user, {
        status: ShipmentStatus.OUT_FOR_DELIVERY,
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: id,
          status: dto.status,
          source: ShipmentEventSource.MANUAL,
          note: dto.note ?? null,
          latitude: dto.latitude ?? null,
          longitude: dto.longitude ?? null,
          createdById: user.userId,
        },
      });
    });
    return this.findDetail(tenantId, id);
  }

  /** POST /shipments/:id/fail: shipment → FAILED, đơn giữ SHIPPING (hàng đã rời kho, quay về qua phiếu hoàn hàng DELIVERY_FAILED). */
  async fail(
    user: AuthUser,
    tenantId: string,
    id: string,
    dto: FailShipmentDto,
  ) {
    const shipment = await this.loadOnTheRoad(user, tenantId, id);
    await this.prisma.$transaction(async (tx) => {
      await this.claimOnTheRoad(tx, shipment, user, {
        status: ShipmentStatus.FAILED,
      });
      await tx.shipmentEvent.create({
        data: {
          shipmentId: id,
          status: ShipmentStatus.FAILED,
          source: ShipmentEventSource.MANUAL,
          note: dto.note,
          createdById: user.userId,
        },
      });
    });

    // Sau commit: người phụ trách là người lo phiếu hoàn hàng. Tự báo thất bại thì không tự báo cho mình.
    const { assigneeId, code } = shipment.order;
    if (assigneeId && assigneeId !== user.userId) {
      await this.notifications.notify({
        tenantId,
        recipientIds: [assigneeId],
        referenceId: id,
        ...ShipmentNotificationTemplates.failed(id, code),
      });
    }
    return this.findDetail(tenantId, id);
  }

  /**
   * Ai được xem shipment nào (chốt 2026-10-06): chủ shop mọi shipment; người khác thấy shipment khi là
   * người phụ trách đơn, là shipper, hoặc có `shipments:read` và đứng ở kho của fulfillment **hoặc** chi
   * nhánh bán đơn – quản lý showroom theo dõi được đơn mình bán dù hàng xuất từ kho tổng. Chỉ cho xem;
   * các thao tác ghi vẫn theo kho của fulfillment (`assertOrderStepAccess`).
   */
  private visibleWhere(
    user: AuthUser,
    tenantId: string,
  ): Prisma.ShipmentWhereInput {
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    ) {
      return { tenantId };
    }
    const reachable: Prisma.ShipmentWhereInput[] = [
      { order: { assigneeId: user.userId } },
      { driverId: user.userId },
    ];
    const posting = user.branchId ?? user.warehouseId;
    if (posting && can(user, 'shipments', 'read')) {
      reachable.push(
        { fulfillment: { locationId: posting } },
        { order: { branchId: posting } },
      );
    }
    return { tenantId, OR: reachable };
  }

  /** Nạp shipment cho ghi nhật trình / báo thất bại, kiểm ai được làm và shipment đang trên đường. */
  private async loadOnTheRoad(user: AuthUser, tenantId: string, id: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        status: true,
        driverId: true,
        fulfillment: { select: { locationId: true } },
        order: {
          select: { id: true, code: true, status: true, assigneeId: true },
        },
      },
    });
    if (!shipment) {
      throw new NotFoundException({
        code: ErrorCode.SHIPMENT_NOT_FOUND,
        message: 'Shipment not found',
      });
    }
    const access = trackingActorAccess(user, shipment);
    // Chỉ báo sớm; chỗ chặn thật là câu ghi có điều kiện trong `claimOnTheRoad`.
    if (
      shipment.order.status !== OrderStatus.SHIPPING ||
      !ON_THE_ROAD_STATUSES.includes(shipment.status)
    ) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: `A ${shipment.status} shipment of a ${shipment.order.status} order is not on the road`,
      });
    }
    return { ...shipment, access };
  }

  /**
   * Ghi trạng thái mới chỉ khi lần giao vẫn đang trên đường (`onTheRoadWhere`) – hai người cùng báo
   * thất bại, hay thất bại đúng lúc giao xong, thì một người nhận 409.
   */
  private async claimOnTheRoad(
    tx: Prisma.TransactionClient,
    shipment: { id: string; access: ShipmentActorAccess },
    user: AuthUser,
    data: { status: string },
  ) {
    const updated = await tx.shipment.updateMany({
      where: onTheRoadWhere(shipment.id, shipment.access, user),
      data,
    });
    if (updated.count !== 1) {
      throw new ConflictException({
        code: ErrorCode.SHIPMENT_STATUS_INVALID,
        message: 'The shipment has just changed, please reload',
      });
    }
  }
}

/**
 * Những tài khoản làm shipper được cho đơn này (chốt 2026-10-06): chủ shop, người phụ trách đơn (toàn
 * quyền với đơn của mình), hoặc STAFF có `shipments:deliver` trong role – đều phải đang hoạt động, cùng
 * shop. Một `where` dùng cho cả kiểm (`assertEligibleDriver`) lẫn liệt kê (`listDrivers`), để ô chọn
 * shipper trên màn hình không bao giờ đưa ra người mà lúc ghi lại bị từ chối. Quyền trưởng ca không tính
 * – nó hết theo giờ, còn việc giao hàng kéo dài qua ca.
 */
function eligibleDriverWhere(
  tenantId: string,
  order: { assigneeId: string | null },
): Prisma.UserWhereInput {
  return {
    tenantId,
    status: UserStatus.ACTIVE,
    OR: [
      { systemRole: SystemRole.TENANT_OWNER },
      ...(order.assigneeId ? [{ id: order.assigneeId }] : []),
      {
        systemRole: SystemRole.STAFF,
        role: { permissions: { some: DRIVER_PERMISSION } },
      },
    ],
  };
}

/** `from` / `to` (YYYY-MM-DD) là ngày theo giờ Việt Nam: đơn tạo lúc 23:30 thuộc đúng ngày đó, không bị đẩy sang hôm sau. */
function createdWithin(
  from: string | undefined,
  to: string | undefined,
): Prisma.ShipmentWhereInput {
  if (!from && !to) return {};
  const day = (value: string) =>
    businessDayRange(new Date(`${value}T00:00:00Z`), VIETNAM_TIMEZONE);
  return {
    createdAt: {
      ...(from ? { gte: day(from).start } : {}),
      ...(to ? { lt: day(to).end } : {}),
    },
  };
}

/** Tìm theo mã đơn, mã vận đơn, tên hoặc SĐT người nhận. */
function searchWhere(search: string): Prisma.ShipmentWhereInput {
  const contains = { contains: search, mode: 'insensitive' as const };
  return {
    OR: [
      { order: { code: contains } },
      { trackingCode: contains },
      { recipientName: contains },
      { recipientPhone: contains },
    ],
  };
}
