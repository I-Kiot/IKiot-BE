import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { InventoryNotificationTemplates } from '../notifications/templates/inventory.templates';
import {
  locationWhere,
  toLocationColumns,
  toLocationRef,
} from '../../common/dto/location-ref.dto';
import type { LocationColumns } from '../../common/dto/location-ref.dto';
import { paginate, skipFor } from '../../common/utils/pagination';
import { crossedLowStock } from './low-stock';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { AddProductToLocationDto } from './dto/add-product-to-location.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const PRODUCT_ITEM_SELECT = {
  id: true,
  sku: true,
  productName: true,
  productCode: true,
  barcode: true,
  images: { select: { url: true, isThumbnail: true, position: true } },
  details: { select: { name: true, value: true, position: true } },
} as const;

type InventoryRow = Prisma.InventoryGetPayload<{
  include: { productItem: { select: typeof PRODUCT_ITEM_SELECT } };
}>;

/** Ported from InventoryService, serving two audiences: the four `/inventory` routes, and the stock primitives Order and StockMovement call - those live here because "what happens to stock, and when do we warn" is one rule. */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  private toResponse(row: InventoryRow) {
    const { branchId, warehouseId, ...rest } = row;
    return { ...rest, location: toLocationRef({ branchId, warehouseId }) };
  }

  async findAll(tenantId: string, query: QueryInventoryDto) {
    const where: Prisma.InventoryWhereInput = {
      tenantId,
      ...locationWhere(query),
    };

    if (query.isLowStock) {
      // A row is low against its own threshold; minStock = 0 switches the alert off for that line, so those are excluded rather than matching everything.
      where.minStock = { gt: 0 };
      where.stock = { lte: this.prisma.inventory.fields.minStock };
    }

    if (query.search) {
      where.productItem = {
        OR: [
          { sku: { contains: query.search, mode: 'insensitive' } },
          { productName: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.inventory.findMany({
        where,
        include: { productItem: { select: PRODUCT_ITEM_SELECT } },
        orderBy: { updatedAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.inventory.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Always scoped by tenant - a row in another tenant must read as nonexistent. */
  private async findRow(tenantId: string, id: string): Promise<InventoryRow> {
    const row = await this.prisma.inventory.findFirst({
      where: { id, tenantId },
      include: { productItem: { select: PRODUCT_ITEM_SELECT } },
    });
    if (!row)
      throw new NotFoundException({
        code: ErrorCode.INVENTORY_NOT_FOUND,
        message: 'Inventory line not found',
      });
    return row;
  }

  /** Set the low-stock threshold for one line; `0` switches the alert off for that item at that location. */
  async updateMinStock(tenantId: string, id: string, minStock: number) {
    await this.findRow(tenantId, id);
    const row = await this.prisma.inventory.update({
      where: { id },
      data: { minStock },
      include: { productItem: { select: PRODUCT_ITEM_SELECT } },
    });
    return this.toResponse(row);
  }

  /**
   * Start stocking a variant at a location, at zero.
   *
   * The way to declare "this branch will carry this" before any of it has arrived - a
   * receipt would create the row anyway, so this is only ever a head start, useful for
   * setting a `minStock` threshold on something that is on order.
   */
  async addProductToLocation(tenantId: string, dto: AddProductToLocationDto) {
    const columns = toLocationColumns(dto);
    await this.assertLocationsExist(tenantId, [columns]);

    const productItem = await this.prisma.productItem.findFirst({
      where: { id: dto.productItemId, tenantId },
      select: { id: true },
    });
    if (!productItem) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    }

    const existing = await this.prisma.inventory.findFirst({
      where: { tenantId, productItemId: dto.productItemId, ...columns },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: ErrorCode.INVENTORY_ALREADY_AT_LOCATION,
        message: 'This product item is already stocked at this location',
      });
    }

    const row = await this.prisma.inventory.create({
      data: {
        tenantId,
        productItemId: dto.productItemId,
        ...columns,
        stock: 0,
        minStock: 0,
      },
      include: { productItem: { select: PRODUCT_ITEM_SELECT } },
    });
    return this.toResponse(row);
  }

  /** Stop stocking a variant at a location. Refuses while any stock is left there. */
  async removeProductFromLocation(tenantId: string, id: string) {
    const existing = await this.findRow(tenantId, id);
    if (existing.stock > 0) {
      throw new BadRequestException({
        code: ErrorCode.INVENTORY_STILL_HAS_STOCK,
        message: `Cannot remove this item from the location while ${existing.stock} in stock remain. Transfer or sell them first.`,
      });
    }

    await this.prisma.inventory.delete({ where: { id } });
    // `{ success: true }` is what iKiotMS-BE answered here and what the frontend checks.
    return { success: true };
  }

  // ─── Stock primitives, for Order / StockMovement ────────────────────────────

  /** Add to (or subtract from) one line's stock, creating the line if the location doesn't stock the item yet. Pass the caller's transactional client, or a rolled-back sale still moves stock. One upserting statement on purpose: a read-then-create lets two receipts both insert and one die on the unique index - and which unique index applies depends on which end is set, since a NULL in a Postgres unique index constrains nothing. */
  async adjustStock(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      productItemId: string;
      branchId: string | null;
      warehouseId: string | null;
      delta: number;
    },
  ): Promise<Inventory | null> {
    if (!args.delta) return null;

    const create = {
      tenantId: args.tenantId,
      productItemId: args.productItemId,
      branchId: args.branchId,
      warehouseId: args.warehouseId,
      stock: args.delta,
      minStock: 0,
    };
    const update = { stock: { increment: args.delta } };

    if (args.branchId) {
      return tx.inventory.upsert({
        where: {
          tenantId_branchId_productItemId: {
            tenantId: args.tenantId,
            branchId: args.branchId,
            productItemId: args.productItemId,
          },
        },
        create,
        update,
      });
    }

    if (!args.warehouseId) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_REQUIRED,
        message: 'A stock adjustment must name a branch or a warehouse',
      });
    }

    return tx.inventory.upsert({
      where: {
        tenantId_warehouseId_productItemId: {
          tenantId: args.tenantId,
          warehouseId: args.warehouseId,
          productItemId: args.productItemId,
        },
      },
      create,
      update,
    });
  }

  /** Take stock off a shelf, refusing to go below zero. The guard is inside the write (`updateMany` with `stock: { gte }`), because reading the level and then decrementing lets two tills both sell the last item. Use this whenever stock is leaving for real; `adjustStock` stays for additions and blind corrections. */
  async deductStock(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      productItemId: string;
      branchId: string | null;
      warehouseId: string | null;
      quantity: number;
      /** Shown in the error - an id tells the cashier nothing. */
      label: string;
    },
  ): Promise<Inventory> {
    if (args.quantity <= 0) {
      throw new BadRequestException({
        code: ErrorCode.QUANTITY_MUST_BE_POSITIVE,
        message: 'The quantity to take out must be greater than 0',
      });
    }

    const where = {
      tenantId: args.tenantId,
      productItemId: args.productItemId,
      branchId: args.branchId,
      warehouseId: args.warehouseId,
    };

    const taken = await tx.inventory.updateMany({
      where: { ...where, stock: { gte: args.quantity } },
      data: { stock: { decrement: args.quantity } },
    });

    if (taken.count === 0) {
      const current = await tx.inventory.findFirst({
        where,
        select: { stock: true },
      });
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `Not enough stock for ${args.label}: ${args.quantity} needed, ${current?.stock ?? 0} left`,
      });
    }

    return tx.inventory.findFirstOrThrow({ where });
  }

  /** Did this change just push a line through its threshold? The rule itself lives in `low-stock.ts` so it can be tested without a database. */
  lowStockCrossing(after: Inventory | null, delta: number): Inventory | null {
    return crossedLowStock(after, delta);
  }

  /** Warn whoever manages that location. Call it after the transaction commits - a rolled-back sale must not leave a warning behind - and it never throws, since the sale has already succeeded. */
  async notifyLowStock(crossings: (Inventory | null)[]): Promise<void> {
    try {
      for (const inventory of crossings.filter(
        (row): row is Inventory => row !== null,
      )) {
        const [recipients, item] = await Promise.all([
          this.notifications.managersOfLocation({
            tenantId: inventory.tenantId,
            branchId: inventory.branchId,
            warehouseId: inventory.warehouseId,
          }),
          this.prisma.productItem.findUnique({
            where: { id: inventory.productItemId },
            select: { sku: true, productName: true },
          }),
        ]);

        await this.notifications.notify({
          tenantId: inventory.tenantId,
          recipientIds: recipients,
          referenceId: inventory.id,
          ...InventoryNotificationTemplates.lowStock({
            label: item?.productName ?? item?.sku ?? 'Một mặt hàng',
            stock: inventory.stock,
            minStock: inventory.minStock,
          }),
        });
      }
    } catch (error) {
      this.logger.error(
        'Failed to send low-stock warnings',
        error instanceof Error ? error.stack : error,
      );
    }
  }

  /** Every location a request names has to exist inside the caller's tenant: the FK would catch a made-up id but knows nothing about tenants, and a single product create can name a location per variant. */
  async assertLocationsExist(
    tenantId: string,
    refs: LocationColumns[],
  ): Promise<void> {
    const branchIds = [
      ...new Set(refs.map((ref) => ref.branchId).filter((id) => id !== null)),
    ];
    const warehouseIds = [
      ...new Set(
        refs.map((ref) => ref.warehouseId).filter((id) => id !== null),
      ),
    ];

    const [branches, warehouses] = await Promise.all([
      branchIds.length
        ? this.prisma.branch.count({
            where: { tenantId, id: { in: branchIds } },
          })
        : 0,
      warehouseIds.length
        ? this.prisma.warehouse.count({
            where: { tenantId, id: { in: warehouseIds } },
          })
        : 0,
    ]);

    if (branches !== branchIds.length) {
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'Branch not found',
      });
    }
    if (warehouses !== warehouseIds.length) {
      throw new NotFoundException({
        code: ErrorCode.WAREHOUSE_NOT_FOUND,
        message: 'Warehouse not found',
      });
    }
  }
}
