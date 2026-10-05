import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventories/inventories.service';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { OrderItem } from '../../../generated/prisma/client';
import { PackOrderDto } from '../orders/dto/pack-order.dto';
import { requireTenantId } from '../../common/utils/tenant-scope';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  OrderStatus,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import { SystemRole } from '../../common/constants/system-role';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { FulfillmentStatus } from '../../common/constants/fulfillment-status';
import { assertTransition } from '../orders/order-status';

/** Đóng gói đơn hàng (C-1): tạo Fulfillment + thùng và khoá hàng tại kho xuất. Route nằm ở OrderController. */

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  /** Đóng gói ở kho xuất dự kiến của các dòng. Kho nào khi các dòng khác nhau: chờ chốt B-2 – tạm thời phải chuyển kho trước. */
  private packLocationOf(lines: OrderItem[]): string {
    const ids = [
      ...new Set(
        lines
          .map((l) => l.sourceLocationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length > 1) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ORDER_NOT_READY,
        message:
          'Lines ship from more than one location - transfer the goods first',
      });
    }
    if (ids.length === 0 || lines.some((l) => l.sourceLocationId === null)) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ORDER_NOT_READY,
        message: 'Every line needs a location to ship from',
      });
    }
    return ids[0];
  }

  /** Chủ / admin đóng ở đâu cũng được; STAFF chỉ ở nơi mình được phân công. TODO: gộp với StockMovementService.canActAt (có cả trưởng ca – supervisesLocation). */
  private assertCanActAt(user: AuthUser, locationId: string) {
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

  /** Mỗi đơn vị hàng × mỗi kiện khai báo của SKU (ProductPackage); SKU không khai báo kiện = 1 thùng. Một query cho cả đơn. */
  private async boxesFor(lines: OrderItem[]) {
    const declared = await this.prisma.productPackage.findMany({
      // ProductPackage không có tenantId – lọc qua SKU của chính đơn này nên không với sang shop khác.
      where: { productItemId: { in: lines.map((l) => l.productItemId) } },
      select: { id: true, productItemId: true },
      orderBy: { position: 'asc' },
    });
    const bySku = new Map<string, string[]>();
    for (const p of declared)
      bySku.set(p.productItemId, [...(bySku.get(p.productItemId) ?? []), p.id]);

    return lines.flatMap((l) => {
      const kinds: (string | null)[] = bySku.get(l.productItemId) ?? [null];
      return Array.from({ length: l.quantity }, () =>
        kinds.map((productPackageId) => ({ productPackageId })),
      ).flat();
    });
  }

  /** Đọc lại fulfillment vừa đóng (kèm dòng hàng và thùng) để trả về cho client. */
  private findPacked(tenantId: string, id: string) {
    return this.prisma.fulfillment.findFirstOrThrow({
      where: { id, tenantId },
      include: {
        items: {
          include: { orderItem: { select: { productName: true, sku: true } } },
        },
        packages: { orderBy: { packedAt: 'asc' } },
      },
    });
  }

  /** CONFIRMED → PACKED (GĐ1–B5): tạo Fulfillment PACKED + thùng, khoá hàng; trên kệ thiếu thì chặn cả đơn. Không trừ `stock` – việc đó ở SHIPPING (C-2). */
  async packOrder(user: AuthUser, orderId: string, dto: PackOrderDto) {
    const tenantId = requireTenantId(user);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: tenantId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException({
        code: ErrorCode.ORDER_NOT_FOUND,
        message: 'Order not found',
      });
    }

    // Chỉ để báo lỗi rõ ràng sớm; chỗ chặn thật là bước "nhận đơn" trong transaction.
    assertTransition(order.status, OrderStatus.PACKED);

    // COMBO cha chỉ mang giá, SERVICE không có hàng – chỉ dòng có tồn mới đóng gói.
    const lines = order.items.filter((l) =>
      STOCKED_LINE_TYPES.includes(l.lineType),
    );
    if (lines.length === 0) {
      throw new ConflictException({
        code: ErrorCode.FULFILLMENT_ORDER_NOT_READY,
        message: 'Nothing on this order needs packing',
      });
    }
    const locationId = this.packLocationOf(lines);
    this.assertCanActAt(user, locationId);
    const boxes = await this.boxesFor(lines);

    const { fulfillmentId, crossings } = await this.prisma.$transaction(
      async (tx) => {
        // 1. Nhận đơn: kiểm trạng thái và ghi trong MỘT câu – hai người bấm cùng lúc thì một người nhận 409.
        const claimed = await tx.order.updateMany({
          where: {
            id: orderId,
            tenantId: tenantId,
            status: OrderStatus.CONFIRMED,
          },
          data: { status: OrderStatus.PACKED },
        });
        if (claimed.count !== 1) {
          throw new ConflictException({
            code: ErrorCode.ORDER_STATUS_CONFLICT,
            message: 'The order status has just changed, please reload',
          });
        }

        // 2. Chứng từ khoá hàng: fulfillment PACKED + item + thùng.
        const now = new Date();
        const fulfillment = await tx.fulfillment.create({
          data: {
            tenantId,
            orderId: order.id,
            locationId,
            status: FulfillmentStatus.PACKED,
            assigneeId: user.userId,
            verifiedById: user.userId,
            verifiedAt: now,
            packedAt: now,
            exceptionNote: dto.note ?? null,
            items: {
              create: lines.map((l) => ({
                orderItemId: l.id,
                quantity: l.quantity,
                qtyPicked: l.quantity,
                qtyPacked: l.quantity,
              })),
            },
          },
          select: { id: true },
        });
        await tx.fulfillmentPackage.createMany({
          data: boxes.map((box) => ({
            tenantId,
            fulfillmentId: fulfillment.id,
            code: generateReference(REFERENCE_PREFIX.PACKAGE),
            productPackageId: box.productPackageId,
            packedById: user.userId,
            packedAt: now,
          })),
        });

        // 3. Khoá hàng (hàng hóa đã có đơn). Thiếu ở bất kỳ dòng nào → INSUFFICIENT_STOCK, rollback cả 1 và 2.
        const locked = await this.inventory.lockStock(
          tx,
          lines.map((l) => ({
            tenantId,
            locationId,
            productItemId: l.productItemId,
            quantity: l.quantity,
            label: l.sku ?? l.productName ?? l.id,
          })),
        );
        return {
          fulfillmentId: fulfillment.id,
          crossings: locked.map(({ row, quantity }) =>
            this.inventory.lowStockCrossing(row, -quantity),
          ),
        };
      },
    );
    // Sau commit: một đơn bị rollback không được để lại cảnh báo.
    await this.inventory.notifyLowStock(crossings);
    return this.findPacked(tenantId, fulfillmentId);
  }
}
