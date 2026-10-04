import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import { ErrorCode } from '../../common/errors/error-codes';
import { AuthUser } from '../../common/types/auth-user.type';
import { SystemRole } from '../../common/constants/system-role';
import {
  FulfillmentStatus,
  UNPACKED_FULFILLMENT_STATUSES,
} from '../../common/constants/fulfillment-status';
import {
  CancelFulfillmentDto,
  CreateFulfillmentDto,
  CreatePackageDto,
  UpdateFulfillmentItemsDto,
} from './dto/fulfillment.dto';
import { requireTenantId } from '../../common/utils/tenant-scope';
import {
  OrderItemStatus,
  OrderStatus,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import { UserStatus } from '../../common/constants/user-status';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { can } from '../../common/utils/permission';
import type { Prisma } from '../../../generated/prisma/client';

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** Cross-tenant ids answer 404, like a missing one. */
  private async findFulfillmentWithItemsAndOrder(tenantId: string, id: string) {
    const row = await this.prisma.fulfillment.findFirst({
      where: { id: id, tenantId: tenantId },
      include: { items: { include: { orderItem: true } }, order: true },
    });
    if (!row) {
      throw new NotFoundException({
        code: ErrorCode.FULFILLMENT_NOT_FOUND,
        message: 'Fulfillment not found',
      });
    }
    return row;
  }

  /** TODO: same rule as StockMovementService.canActAt (minus shift supervision) - fold the two into one shared helper. Owner/admin act anywhere, STAFF only where posted. A Branch/Warehouse id is its Location id. */
  private assertUserCanActAtLocation(user: AuthUser, locationId: string) {
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    )
      return;
    if ((user.branchId ?? user.warehouseId) !== locationId) {
      throw new ForbiddenException({
        code: ErrorCode.FULFILLMENT_LOCATION_DENIED,
        message: 'You can only pack at your own location',
      });
    }
  }

  /** TODO(A-1): replace with deriveLineStatus / deriveOrderStatus (docs/api-contract-order-flow.md §1). Sets PACKED directly, which ignores COMBO/SERVICE lines and lines changed after the fulfillment was created. */
  private async markOrderItemsAndOrderAsPacked(
    tx: Prisma.TransactionClient,
    orderId: string,
    orderItemIds: string[],
  ) {
    await tx.orderItem.updateMany({
      where: { id: { in: orderItemIds } },
      data: { status: OrderItemStatus.PACKED },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PACKED },
    });
  }

  private assertFulfillmentIsUnpacked(status: string) {
    if (!UNPACKED_FULFILLMENT_STATUSES.includes(status)) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_STATUS_INVALID,
        message: `Fulfillment is already ${status}`,
      });
    }
  }

  async findFulfillmentById(user: AuthUser, id: string) {
    const tenantId = requireTenantId(user);
    const row = await this.prisma.fulfillment.findFirst({
      where: { id, tenantId },
      include: {
        items: {
          include: { orderItem: { select: { productName: true, sku: true } } },
        },
        packages: true,
      },
    });
    if (!row)
      throw new NotFoundException({
        code: ErrorCode.FULFILLMENT_NOT_FOUND,
        message: 'Fulfillment not found',
      });
    return row;
  }

  async createFulfillment(user: AuthUser, dto: CreateFulfillmentDto) {
    const tenantId = requireTenantId(user);
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: tenantId },
      include: { items: true },
    });
    if (!order)
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    if (order.status !== OrderStatus.READY_TO_PACK) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ORDER_NOT_READY,
        message: `Order is ${order.status}, not READY_TO_PACK`,
      });
    }

    const existing = await this.prisma.fulfillment.findFirst({
      where: {
        tenantId: tenantId,
        orderId: dto.orderId,
        status: { not: FulfillmentStatus.CANCELLED },
      },
    });
    if (existing)
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ALREADY_EXISTS,
        message: 'This order already has a fulfillment',
      });

    const lines = order.items.filter(
      (l) =>
        STOCKED_LINE_TYPES.includes(l.lineType) &&
        l.status === OrderItemStatus.READY,
    );

    // Nothing holds stock any more (docs/hanh-trinh-don-hang.md): the order is packed where its
    // lines are due to ship from. Track C replaces this module with POST /orders/:id/pack (contract §2).
    const locationIds = [
      ...new Set(
        lines
          .map((l) => l.sourceLocationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (locationIds.length !== 1) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ORDER_NOT_READY,
        message:
          locationIds.length === 0
            ? 'No line names a location to ship from'
            : 'Lines ship from more than one location - transfer the goods first',
      });
    }

    const locationId = locationIds[0];
    this.assertUserCanActAtLocation(user, locationId);

    if (dto.assigneeId) {
      const assignee = await this.prisma.user.findFirst({
        where: { id: dto.assigneeId, tenantId, status: UserStatus.ACTIVE },
      });
      if (!assignee)
        throw new NotFoundException({
          code: ErrorCode.USER_NOT_FOUND,
          message: 'Assignee not found',
        });
    }

    const created = await this.prisma.fulfillment.create({
      data: {
        tenantId: tenantId,
        orderId: order.id,
        locationId: locationId,
        status: FulfillmentStatus.PENDING,
        assigneeId: dto.assigneeId ?? null,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        items: {
          create: lines.map((l) => ({
            orderItemId: l.id,
            quantity: l.quantity,
          })),
        },
      },
    });
    return this.findFulfillmentById(user, created.id);
  }

  async updateFulfillmentItems(
    user: AuthUser,
    id: string,
    dto: UpdateFulfillmentItemsDto,
  ) {
    const f = await this.findFulfillmentWithItemsAndOrder(
      requireTenantId(user),
      id,
    );
    this.assertUserCanActAtLocation(user, f.locationId);
    this.assertFulfillmentIsUnpacked(f.status);

    const byOrderItem = new Map(f.items.map((i) => [i.orderItemId, i]));
    const updates = dto.items.map((input) => {
      const item = byOrderItem.get(input.orderItemId);
      if (!item)
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: `${input.orderItemId} is not on this fulfillment`,
        });
      const qtyPicked = input.qtyPicked ?? item.qtyPicked;
      const qtyPacked = input.qtyPacked ?? item.qtyPacked;
      if (qtyPacked > qtyPicked || qtyPicked > item.quantity) {
        throw new BadRequestException({
          code: ErrorCode.FULFILLMENT_QTY_EXCEEDS,
          message: `Need packed <= picked <= ${item.quantity}`,
        });
      }
      return this.prisma.fulfillmentItem.update({
        where: { id: item.id },
        data: { qtyPicked, qtyPacked },
      });
    });

    await this.prisma.$transaction([
      ...updates,
      this.prisma.fulfillment.update({
        where: { id: f.id },
        data: {
          status: FulfillmentStatus.PACKING,
          packStartedAt: f.packStartedAt ?? new Date(),
        },
      }),
    ]);
    return this.findFulfillmentById(user, f.id);
  }

  async addFulfillmentPackage(
    user: AuthUser,
    id: string,
    dto: CreatePackageDto,
  ) {
    const tenantId = requireTenantId(user);
    const f = await this.findFulfillmentWithItemsAndOrder(tenantId, id);
    this.assertUserCanActAtLocation(user, f.locationId);
    this.assertFulfillmentIsUnpacked(f.status);

    if (dto.productPackageId) {
      // ProductPackage has no tenantId - it must belong to a SKU on this fulfillment, or it could name another shop's.
      const skuIds = f.items.map((i) => i.orderItem.productItemId);
      const pkg = await this.prisma.productPackage.findFirst({
        where: { id: dto.productPackageId, productItemId: { in: skuIds } },
      });
      if (!pkg) {
        throw new BadRequestException({
          code: ErrorCode.VALIDATION_FAILED,
          message: 'ProductPackage does not match any SKU on this fulfillment',
        });
      }
    }

    await this.prisma.fulfillmentPackage.create({
      data: {
        tenantId: tenantId,
        fulfillmentId: f.id,
        code: generateReference(REFERENCE_PREFIX.PACKAGE),
        productPackageId: dto.productPackageId ?? null,
        weightKg: dto.weightKg ?? null,
        photoUrls: dto.photoUrls ?? [],
        packedById: user.userId,
      },
    });
    return this.findFulfillmentById(user, f.id);
  }

  async verifyFulfillmentAndDeductStock(user: AuthUser, id: string) {
    const tenantId = requireTenantId(user);
    const f = await this.findFulfillmentWithItemsAndOrder(tenantId, id);
    this.assertUserCanActAtLocation(user, f.locationId);

    // Either the permission or being the order's person in charge - which is why the route carries no @Permissions.
    if (
      !can(user, 'fulfillments', 'verify') &&
      f.order.assigneeId !== user.userId
    ) {
      throw new ForbiddenException({
        code: ErrorCode.FULFILLMENT_VERIFY_DENIED,
        message: 'Only the person in charge may verify this order',
      });
    }
    this.assertFulfillmentIsUnpacked(f.status);

    const notPacked = f.items.find((i) => i.qtyPacked !== i.quantity);
    if (notPacked) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_STATUS_INVALID,
        message: `${notPacked.orderItem.productName ?? notPacked.orderItemId} is not fully packed`,
      });
    }

    // Packages needed = Σ quantity × max(1, packages of that SKU). Counts only - which box is which is not checked yet.
    const skuIds = f.items.map((i) => i.orderItem.productItemId);
    const perSku = await this.prisma.productPackage.groupBy({
      by: ['productItemId'],
      where: { productItemId: { in: skuIds } },
      _count: true,
    });
    const countOf = new Map(perSku.map((p) => [p.productItemId, p._count]));
    const required = f.items.reduce(
      (sum, i) =>
        sum +
        i.quantity * Math.max(1, countOf.get(i.orderItem.productItemId) ?? 0),
      0,
    );
    const packed = await this.prisma.fulfillmentPackage.count({
      where: { fulfillmentId: f.id },
    });
    if (packed < required) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_PACKAGES_INCOMPLETE,
        message: `${packed} of ${required} packages packed`,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Guard and write in one statement: two clicks must not verify twice.
      const { count } = await tx.fulfillment.updateMany({
        where: { id: f.id, status: { in: [...UNPACKED_FULFILLMENT_STATUSES] } },
        data: {
          status: FulfillmentStatus.PACKED,
          verifiedById: user.userId,
          verifiedAt: now,
          packedAt: now,
        },
      });
      if (count !== 1) {
        throw new ConflictException({
          code: ErrorCode.FULFILLMENT_STATUS_INVALID,
          message: 'Fulfillment was verified meanwhile',
        });
      }

      // Packing no longer deducts stock - that happens when the order moves to SHIPPING
      // (POST /orders/:id/ship, deductStock with the order line on the ledger).
      await this.markOrderItemsAndOrderAsPacked(
        tx,
        f.orderId,
        f.items.map((i) => i.orderItemId),
      );
    });
    return this.findFulfillmentById(user, id);
  }

  async cancelFulfillment(
    user: AuthUser,
    id: string,
    dto: CancelFulfillmentDto,
  ) {
    const f = await this.findFulfillmentWithItemsAndOrder(
      requireTenantId(user),
      id,
    );
    this.assertUserCanActAtLocation(user, f.locationId);
    this.assertFulfillmentIsUnpacked(f.status);
    // Packing touched no stock, so cancelling it has nothing to give back.
    await this.prisma.fulfillment.update({
      where: { id: f.id },
      data: {
        status: FulfillmentStatus.CANCELLED,
        exceptionNote: dto.note ?? null,
      },
    });
    return this.findFulfillmentById(user, id);
  }
}
