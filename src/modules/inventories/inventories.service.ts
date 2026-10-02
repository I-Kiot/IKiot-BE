import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../notifications/notifications.service';
import { InventoryNotificationTemplates } from '../notifications/templates/inventory.templates';
import {
  LOCATION_SELECT,
  locationWhere,
  resolveLocations,
} from '../../common/dto/location-ref.dto';
import { paginate, skipFor } from '../../common/utils/pagination';
import { crossedLowStock } from './low-stock';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { AddProductToLocationDto } from './dto/add-product-to-location.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  InventoryTxType,
  type InventoryRefType,
  type LotSourceType,
} from '../../common/constants/inventory-ledger';
import { ReservationStatus } from '../../common/constants/reservation-status';
import {
  OrderItemStatus,
  RESERVING_ORDER_STATUSES,
  STOCKED_LINE_TYPES,
} from '../../common/constants/order-status';
import {
  averageUnitCost,
  planArrivalAllocation,
  planDraw,
  planReturn,
  runningBalances,
  type LineAllocation,
} from './lot-allocation';

/** One SKU at one location - the key of an `inventories` row. */
export interface StockKey {
  tenantId: string;
  productItemId: string;
  /** A Location id - the same id as the Branch or Warehouse it specializes. */
  locationId: string;
}

/** What a stock change records about itself in the ledger. */
export interface LedgerRef {
  type: InventoryTxType;
  referenceType: InventoryRefType;
  referenceId: string;
  createdById?: string | null;
  note?: string | null;
  /** SALE / SALE_REVERSAL / RETURN_* rows: the order line, so its cost of goods sold can be read off the ledger. */
  orderItemId?: string | null;
}

/** What `allocateArrivals` held for one waiting line. */
export interface ArrivalAllocation extends LineAllocation {
  orderId: string;
}

const PRODUCT_ITEM_SELECT = {
  id: true,
  sku: true,
  productName: true,
  productCode: true,
  barcode: true,
  images: { select: { url: true, isThumbnail: true, position: true } },
  details: { select: { name: true, value: true, position: true } },
} as const;

const INVENTORY_INCLUDE = {
  productItem: { select: PRODUCT_ITEM_SELECT },
  location: LOCATION_SELECT,
} as const satisfies Prisma.InventoryInclude;

type InventoryRow = Prisma.InventoryGetPayload<{
  include: typeof INVENTORY_INCLUDE;
}>;

/** Ported from InventoryService, serving two audiences: the four `/inventory` routes, and the stock primitives Order and StockMovement call - those live here because "what happens to stock, and when do we warn" is one rule. */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /** `location` is already the shared `{ id, type, name }` (LOCATION_SELECT); `locationId` is dropped so the response names the place once. */
  private toResponse(row: InventoryRow) {
    const { locationId, ...rest } = row;
    return rest;
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
        include: INVENTORY_INCLUDE,
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
      include: INVENTORY_INCLUDE,
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
      include: INVENTORY_INCLUDE,
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
    await resolveLocations(this.prisma, tenantId, [dto.locationId]);

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

    const { locationId } = dto;
    const existing = await this.prisma.inventory.findFirst({
      where: { tenantId, productItemId: dto.productItemId, locationId },
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
        locationId,
        stock: 0,
        minStock: 0,
      },
      include: INVENTORY_INCLUDE,
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

  // ─── Stock primitives, for Order / StockMovement / Fulfillment / OrderReturn ──
  //
  // The rules every caller shares (schema header, docs/order-flow.md):
  //   - available = stock - reserved. Holding stock (reserve) only raises `reserved`; the goods
  //     leave when the line is packed (consume), which lowers both.
  //   - Stock sits in lots: Σ lot.remainingQuantity = inventories.stock, always. Every change
  //     writes ledger rows (InventoryTransaction), one per lot it touches.
  //   - Every write takes the caller's transactional client - a rolled-back sale must not have
  //     moved stock - and the guard that refuses an impossible move is inside the same UPDATE
  //     that makes it, never a read followed by a write.
  //   - The inventory row is always written before its lots, so concurrent moves of one SKU at
  //     one location queue on that row's lock and see each other's lot changes.

  /** Goods arrive that were never ours before (an import, a stocktake surplus): one new lot, its stock, and the inbound ledger row. Leave `unitCost` out to cost the lot at the variant's current cost price. */
  async openLot(
    tx: Prisma.TransactionClient,
    args: StockKey & {
      quantity: number;
      unitCost?: number;
      sourceType: LotSourceType;
      supplierId?: string | null;
      importItemId?: string | null;
      productionRequestItemId?: string | null;
      /** Only for a piece made for one custom order line - no other line may ever draw it. */
      orderItemId?: string | null;
      /** FIFO key. Defaults to now. */
      receivedAt?: Date;
      ledger: LedgerRef;
    },
  ): Promise<{ inventory: Inventory; lotId: string }> {
    this.assertPositive(args.quantity);
    const unitCost =
      args.unitCost ?? (await this.currentCostPrice(tx, args.productItemId));

    const inventory = await this.incrementStock(tx, args, args.quantity);
    const lot = await tx.inventoryLot.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productItemId: args.productItemId,
        sourceType: args.sourceType,
        supplierId: args.supplierId ?? null,
        importItemId: args.importItemId ?? null,
        productionRequestItemId: args.productionRequestItemId ?? null,
        orderItemId: args.orderItemId ?? null,
        unitCost,
        receivedQuantity: args.quantity,
        remainingQuantity: args.quantity,
        receivedAt: args.receivedAt ?? new Date(),
      },
      select: { id: true },
    });

    await this.writeLedger(tx, [
      this.ledgerRow(args, args.ledger, {
        lotId: lot.id,
        quantity: args.quantity,
        balanceAfter: inventory.stock,
        unitCost,
      }),
    ]);
    return { inventory, lotId: lot.id };
  }

  /** Take free stock off a shelf - a transfer leaving, a stocktake shortage, a till sale that never held anything. Refuses to dip into what is held for orders (`stock - reserved >= quantity`, checked inside the UPDATE, because reading the level and then decrementing lets two tills both sell the last item), then draws the lots FIFO. Packing an order line goes through `consume`, not this. */
  async deductStock(
    tx: Prisma.TransactionClient,
    args: StockKey & {
      quantity: number;
      /** Shown in the error - an id tells the cashier nothing. */
      label: string;
      ledger: LedgerRef;
    },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);

    const taken = await tx.$executeRaw`
      UPDATE "inventories"
      SET "stock" = "stock" - ${args.quantity}, "updated_at" = now()
      WHERE "tenant_id" = ${args.tenantId}
        AND "location_id" = ${args.locationId}
        AND "product_item_id" = ${args.productItemId}
        AND "stock" - "reserved" >= ${args.quantity}`;

    if (taken === 0) {
      const current = await tx.inventory.findFirst({
        where: this.keyWhere(args),
        select: { stock: true, reserved: true },
      });
      const available = current ? current.stock - current.reserved : 0;
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `Not enough stock for ${args.label}: ${args.quantity} needed, ${available} available${current?.reserved ? ` (${current.reserved} held for orders)` : ''}`,
      });
    }

    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(args),
    });
    await this.drawLots(tx, args, args.quantity, inventory.stock, args.ledger);
    return inventory;
  }

  /**
   * Goods coming back against the document that took them out, to the lots they left:
   * a transfer received (`drawnBy` the movement, `toLocationId` the destination - each unit
   * becomes a child lot keeping its source and cost), a transfer cancelled in transit or a
   * packed sale cancelled before hand-over (same location - straight back into the original
   * lots), a customer return (`drawnBy` the order line, possibly to a damaged-goods location).
   * Refuses to bring back more than went out and has not already come back.
   *
   * `ifNeverDrawn` is for paperwork older than lots (2026-10-02): a sale or a transfer that
   * left before the migration has no ledger rows to follow, so its goods come back as a fresh
   * lot of that source instead. Leave it out where that cannot happen.
   */
  async returnDrawn(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      productItemId: string;
      toLocationId: string;
      quantity: number;
      drawnBy:
        | { referenceType: InventoryRefType; referenceId: string }
        | { orderItemId: string };
      ledger: LedgerRef;
      ifNeverDrawn?: { sourceType: LotSourceType };
    },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);
    const key: StockKey = {
      tenantId: args.tenantId,
      productItemId: args.productItemId,
      locationId: args.toLocationId,
    };
    const matching: Prisma.InventoryTransactionWhereInput = {
      tenantId: args.tenantId,
      productItemId: args.productItemId,
      ...('orderItemId' in args.drawnBy
        ? { orderItemId: args.drawnBy.orderItemId }
        : {
            referenceType: args.drawnBy.referenceType,
            referenceId: args.drawnBy.referenceId,
          }),
    };
    // Rows a return writes carry the order line too, so the next return sees them.
    const ledger: LedgerRef =
      'orderItemId' in args.drawnBy
        ? { ...args.ledger, orderItemId: args.drawnBy.orderItemId }
        : args.ledger;

    const [outbound, inbound] = await Promise.all([
      tx.inventoryTransaction.findMany({
        where: { ...matching, quantity: { lt: 0 } },
        select: { lotId: true, quantity: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.inventoryTransaction.findMany({
        where: { ...matching, quantity: { gt: 0 } },
        select: {
          lotId: true,
          quantity: true,
          lot: { select: { parentLotId: true } },
        },
      }),
    ]);

    if (outbound.length === 0 && args.ifNeverDrawn) {
      const { inventory } = await this.openLot(tx, {
        ...key,
        quantity: args.quantity,
        sourceType: args.ifNeverDrawn.sourceType,
        ledger,
      });
      return inventory;
    }

    const drawn = new Map<string, { drawn: number; returned: number }>();
    for (const row of outbound) {
      const entry = drawn.get(row.lotId) ?? { drawn: 0, returned: 0 };
      entry.drawn -= row.quantity;
      drawn.set(row.lotId, entry);
    }
    for (const row of inbound) {
      // Back into the lot itself (same location) or into a lot split off from it.
      const origin = drawn.has(row.lotId) ? row.lotId : row.lot.parentLotId;
      const entry = origin ? drawn.get(origin) : undefined;
      if (entry) entry.returned += row.quantity;
    }

    const slices = planReturn(
      [...drawn].map(([lotId, entry]) => ({ lotId, ...entry })),
      args.quantity,
    );
    if (!slices) {
      throw new ConflictException({
        code: ErrorCode.INVENTORY_LOT_SHORTAGE,
        message: `Cannot bring back ${args.quantity} of ${args.productItemId}: the document only took out fewer that have not come back yet`,
      });
    }

    const lots = await tx.inventoryLot.findMany({
      where: { id: { in: slices.map((slice) => slice.lotId) } },
    });
    const lotById = new Map(lots.map((lot) => [lot.id, lot]));

    const inventory = await this.incrementStock(tx, key, args.quantity);
    const balances = runningBalances(
      inventory.stock - args.quantity,
      slices.map((slice) => slice.quantity),
    );

    const rows: Prisma.InventoryTransactionCreateManyInput[] = [];
    for (const [index, slice] of slices.entries()) {
      const origin = lotById.get(slice.lotId)!;
      let lotId = origin.id;
      if (origin.locationId === args.toLocationId) {
        await tx.inventoryLot.update({
          where: { id: origin.id },
          data: { remainingQuantity: { increment: slice.quantity } },
        });
      } else {
        const child = await tx.inventoryLot.create({
          data: {
            tenantId: origin.tenantId,
            locationId: args.toLocationId,
            productItemId: origin.productItemId,
            sourceType: origin.sourceType,
            supplierId: origin.supplierId,
            importItemId: origin.importItemId,
            productionRequestItemId: origin.productionRequestItemId,
            orderItemId: origin.orderItemId,
            parentLotId: origin.id,
            unitCost: origin.unitCost,
            receivedQuantity: slice.quantity,
            remainingQuantity: slice.quantity,
            receivedAt: origin.receivedAt,
          },
          select: { id: true },
        });
        lotId = child.id;
      }
      rows.push(
        this.ledgerRow(key, ledger, {
          lotId,
          quantity: slice.quantity,
          balanceAfter: balances[index],
          unitCost: origin.unitCost,
        }),
      );
    }
    await this.writeLedger(tx, rows);
    if (ledger.type === InventoryTxType.SALE_REVERSAL && ledger.orderItemId) {
      await this.refreshLineCost(tx, ledger.orderItemId);
    }
    return inventory;
  }

  /**
   * Hold stock for one order line at one location (docs/order-flow.md B2). The availability
   * check and the increment of `reserved` are one statement. With `allowPartial`, holds what is
   * there (the line keeps waiting for the rest) and answers `held: 0` when nothing is;
   * without it, holds all of it or throws. Never holds at a damaged-goods location.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    args: StockKey & {
      orderItemId: string;
      quantity: number;
      allowPartial?: boolean;
      label?: string;
    },
  ): Promise<{ held: number; reservationId: string | null }> {
    this.assertPositive(args.quantity);
    await this.assertSellable(tx, args.tenantId, args.locationId);

    const allowPartial = args.allowPartial ?? false;
    const rows = await tx.$queryRaw<{ take: number }[]>`
      WITH target AS (
        SELECT "id", LEAST(${args.quantity}::int, "stock" - "reserved") AS take
        FROM "inventories"
        WHERE "tenant_id" = ${args.tenantId}
          AND "location_id" = ${args.locationId}
          AND "product_item_id" = ${args.productItemId}
        FOR UPDATE
      )
      UPDATE "inventories" i
      SET "reserved" = i."reserved" + target.take, "updated_at" = now()
      FROM target
      WHERE i."id" = target."id"
        AND target.take > 0
        AND (${allowPartial}::boolean OR target.take >= ${args.quantity}::int)
      RETURNING target.take AS take`;
    const held = rows[0]?.take ?? 0;

    if (held === 0) {
      if (allowPartial) return { held: 0, reservationId: null };
      const current = await tx.inventory.findFirst({
        where: this.keyWhere(args),
        select: { stock: true, reserved: true },
      });
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_AVAILABLE_STOCK,
        message: `Not enough available stock for ${args.label ?? args.productItemId}: ${args.quantity} needed, ${current ? current.stock - current.reserved : 0} available`,
      });
    }

    const reservation = await tx.stockReservation.create({
      data: {
        tenantId: args.tenantId,
        orderItemId: args.orderItemId,
        locationId: args.locationId,
        quantity: held,
        status: ReservationStatus.ACTIVE,
      },
      select: { id: true },
    });
    return { held, reservationId: reservation.id };
  }

  /** Hand back everything a line holds (optionally only at one location): its ACTIVE reservations turn RELEASED and `reserved` drops by as much. Call it **before** pointing the line at a different SKU (a custom piece) - the reservation does not store the SKU, it is read off the line. Returns the quantity released. */
  async release(
    tx: Prisma.TransactionClient,
    args: { tenantId: string; orderItemId: string; locationId?: string },
  ): Promise<number> {
    const holds = await tx.$queryRaw<
      { id: string; location_id: string; quantity: number }[]
    >`
      SELECT r."id", r."location_id", r."quantity"
      FROM "stock_reservations" r
      WHERE r."tenant_id" = ${args.tenantId}
        AND r."order_item_id" = ${args.orderItemId}
        AND r."status" = ${ReservationStatus.ACTIVE}
        AND (${args.locationId ?? null}::text IS NULL OR r."location_id" = ${args.locationId ?? null}::text)
      FOR UPDATE`;
    if (holds.length === 0) return 0;

    const { productItemId } = await tx.orderItem.findUniqueOrThrow({
      where: { id: args.orderItemId },
      select: { productItemId: true },
    });

    await tx.stockReservation.updateMany({
      where: { id: { in: holds.map((hold) => hold.id) } },
      data: { status: ReservationStatus.RELEASED },
    });

    const byLocation = new Map<string, number>();
    for (const hold of holds) {
      byLocation.set(
        hold.location_id,
        (byLocation.get(hold.location_id) ?? 0) + hold.quantity,
      );
    }
    for (const [locationId, quantity] of byLocation) {
      await tx.$executeRaw`
        UPDATE "inventories"
        SET "reserved" = "reserved" - ${quantity}, "updated_at" = now()
        WHERE "tenant_id" = ${args.tenantId}
          AND "location_id" = ${locationId}
          AND "product_item_id" = ${productItemId}`;
    }
    return holds.reduce((sum, hold) => sum + hold.quantity, 0);
  }

  /**
   * Packing (docs/order-flow.md B5): the line's hold at that location turns CONSUMED and the
   * stock actually leaves - `stock` and `reserved` both drop, the lots are drawn (the line's
   * own made-to-order lot first, then FIFO) with one SALE row per lot carrying the order line,
   * and the line's `unitCostPrice` is recomputed from those rows. Packing more than the line
   * holds there is refused. Can be called per batch of units as they are packed.
   */
  async consume(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      orderItemId: string;
      locationId: string;
      quantity: number;
      label?: string;
      /** Defaults to SALE; the order line is always attached. */
      ledger: Omit<LedgerRef, 'type' | 'orderItemId'> & {
        type?: InventoryTxType;
      };
    },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);

    const holds = await tx.$queryRaw<{ id: string; quantity: number }[]>`
      SELECT "id", "quantity"
      FROM "stock_reservations"
      WHERE "tenant_id" = ${args.tenantId}
        AND "order_item_id" = ${args.orderItemId}
        AND "location_id" = ${args.locationId}
        AND "status" = ${ReservationStatus.ACTIVE}
      ORDER BY "created_at", "id"
      FOR UPDATE`;
    const held = holds.reduce((sum, hold) => sum + hold.quantity, 0);
    if (held < args.quantity) {
      throw new ConflictException({
        code: ErrorCode.RESERVATION_NOT_ACTIVE,
        message: `${args.label ?? args.orderItemId} holds ${held} at this location, cannot pack ${args.quantity}`,
      });
    }

    let left = args.quantity;
    for (const hold of holds) {
      if (left <= 0) break;
      const take = Math.min(left, hold.quantity);
      if (take === hold.quantity) {
        await tx.stockReservation.update({
          where: { id: hold.id },
          data: { status: ReservationStatus.CONSUMED },
        });
      } else {
        // Part of the hold is packed: the rest stays ACTIVE, the packed part is its own CONSUMED row.
        await tx.stockReservation.update({
          where: { id: hold.id },
          data: { quantity: { decrement: take } },
        });
        await tx.stockReservation.create({
          data: {
            tenantId: args.tenantId,
            orderItemId: args.orderItemId,
            locationId: args.locationId,
            quantity: take,
            status: ReservationStatus.CONSUMED,
          },
        });
      }
      left -= take;
    }

    const { productItemId } = await tx.orderItem.findUniqueOrThrow({
      where: { id: args.orderItemId },
      select: { productItemId: true },
    });
    const key: StockKey = {
      tenantId: args.tenantId,
      locationId: args.locationId,
      productItemId,
    };

    const taken = await tx.$executeRaw`
      UPDATE "inventories"
      SET "stock" = "stock" - ${args.quantity},
          "reserved" = "reserved" - ${args.quantity},
          "updated_at" = now()
      WHERE "tenant_id" = ${key.tenantId}
        AND "location_id" = ${key.locationId}
        AND "product_item_id" = ${key.productItemId}
        AND "stock" >= ${args.quantity}
        AND "reserved" >= ${args.quantity}`;
    if (taken === 0) {
      // The reservations said the goods were held here; the inventory row disagrees.
      throw new ConflictException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `The stock row for ${args.label ?? productItemId} does not cover the ${args.quantity} held for it`,
      });
    }

    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(key),
    });
    await this.drawLots(tx, key, args.quantity, inventory.stock, {
      ...args.ledger,
      type: args.ledger.type ?? InventoryTxType.SALE,
      orderItemId: args.orderItemId,
    });
    return inventory;
  }

  /**
   * Goods just arrived at a location (an import received): hold them for the order lines
   * waiting on that SKU there (docs/order-flow.md B4.4) - the lines they were made for
   * first (`priorityOrderItemIds`, e.g. the production request lines' order lines), then the
   * other WAITING_STOCK lines by order confirmation time; the rest stays free. A line held in
   * full becomes READY. Recomputing the order status and telling the person in charge is the
   * caller's job (A-6) - this returns what it held, per line.
   */
  async allocateArrivals(
    tx: Prisma.TransactionClient,
    args: StockKey & { priorityOrderItemIds?: string[] },
  ): Promise<ArrivalAllocation[]> {
    const location = await tx.location.findFirst({
      where: { id: args.locationId, tenantId: args.tenantId },
      select: { isSellable: true },
    });
    if (!location?.isSellable) return [];

    const [row] = await tx.$queryRaw<{ id: string; available: number }[]>`
      SELECT "id", "stock" - "reserved" AS available
      FROM "inventories"
      WHERE "tenant_id" = ${args.tenantId}
        AND "location_id" = ${args.locationId}
        AND "product_item_id" = ${args.productItemId}
      FOR UPDATE`;
    if (!row || row.available <= 0) return [];

    const priorityIds = args.priorityOrderItemIds ?? [];
    const lines = await tx.orderItem.findMany({
      where: {
        productItemId: args.productItemId,
        status: OrderItemStatus.WAITING_STOCK,
        lineType: { in: [...STOCKED_LINE_TYPES] },
        order: {
          tenantId: args.tenantId,
          status: { in: [...RESERVING_ORDER_STATUSES] },
        },
        OR: [
          { sourceLocationId: args.locationId },
          { id: { in: priorityIds } },
        ],
      },
      select: {
        id: true,
        orderId: true,
        quantity: true,
        order: { select: { confirmedAt: true } },
        stockReservations: {
          where: {
            status: {
              in: [ReservationStatus.ACTIVE, ReservationStatus.CONSUMED],
            },
          },
          select: { quantity: true },
        },
      },
    });

    const waiting = lines.map((line) => ({
      orderItemId: line.id,
      missing:
        line.quantity -
        line.stockReservations.reduce((sum, hold) => sum + hold.quantity, 0),
      confirmedAt: line.order.confirmedAt,
    }));
    const byId = new Map(waiting.map((line) => [line.orderItemId, line]));
    const plan = planArrivalAllocation(
      row.available,
      priorityIds.flatMap((id) => byId.get(id) ?? []),
      waiting,
    );
    if (plan.length === 0) return [];

    const total = plan.reduce((sum, line) => sum + line.quantity, 0);
    await tx.$executeRaw`
      UPDATE "inventories"
      SET "reserved" = "reserved" + ${total}, "updated_at" = now()
      WHERE "id" = ${row.id}`;
    await tx.stockReservation.createMany({
      data: plan.map((line) => ({
        tenantId: args.tenantId,
        orderItemId: line.orderItemId,
        locationId: args.locationId,
        quantity: line.quantity,
        status: ReservationStatus.ACTIVE,
      })),
    });
    const completed = plan
      .filter((line) => line.complete)
      .map((line) => line.orderItemId);
    if (completed.length > 0) {
      await tx.orderItem.updateMany({
        where: { id: { in: completed } },
        data: {
          status: OrderItemStatus.READY,
          sourceLocationId: args.locationId,
        },
      });
    }

    const orderIdOf = new Map(lines.map((line) => [line.id, line.orderId]));
    return plan.map((line) => ({
      ...line,
      orderId: orderIdOf.get(line.orderItemId)!,
    }));
  }

  /** Append ledger rows. Every stock change goes through the primitives above, which call this - write it directly only for a row that moves no stock. */
  async writeLedger(
    tx: Prisma.TransactionClient,
    rows: Prisma.InventoryTransactionCreateManyInput[],
  ): Promise<void> {
    if (rows.length > 0)
      await tx.inventoryTransaction.createMany({ data: rows });
  }

  // ─── Primitive internals ────────────────────────────────────────────────────

  /** Draw `quantity` from the lots after `inventories.stock` has already been lowered to `stockAfter`. */
  private async drawLots(
    tx: Prisma.TransactionClient,
    key: StockKey,
    quantity: number,
    stockAfter: number,
    ledger: LedgerRef,
  ): Promise<void> {
    const orderItemId = ledger.orderItemId ?? null;
    const lots = await tx.$queryRaw<
      {
        id: string;
        remaining_quantity: number;
        received_at: Date;
        order_item_id: string | null;
        unit_cost: Prisma.Decimal;
      }[]
    >`
      SELECT "id", "remaining_quantity", "received_at", "order_item_id", "unit_cost"
      FROM "inventory_lots"
      WHERE "tenant_id" = ${key.tenantId}
        AND "location_id" = ${key.locationId}
        AND "product_item_id" = ${key.productItemId}
        AND "remaining_quantity" > 0
        AND ("order_item_id" IS NULL OR "order_item_id" = ${orderItemId}::text)
      FOR UPDATE`;

    const slices = planDraw(
      lots.map((lot) => ({
        id: lot.id,
        remainingQuantity: lot.remaining_quantity,
        receivedAt: lot.received_at,
        orderItemId: lot.order_item_id,
      })),
      quantity,
      orderItemId,
    );
    if (!slices) {
      // `inventories.stock` covered it, the lots did not: Σ lot.remaining has drifted from stock.
      throw new InternalServerErrorException({
        code: ErrorCode.INVENTORY_LOT_SHORTAGE,
        message: `The lots of ${key.productItemId} at ${key.locationId} hold less than its stock - cannot draw ${quantity}`,
      });
    }

    const costOf = new Map(lots.map((lot) => [lot.id, lot.unit_cost]));
    const balances = runningBalances(
      stockAfter + quantity,
      slices.map((slice) => -slice.quantity),
    );
    for (const slice of slices) {
      await tx.inventoryLot.update({
        where: { id: slice.lotId },
        data: { remainingQuantity: { decrement: slice.quantity } },
      });
    }
    await this.writeLedger(
      tx,
      slices.map((slice, index) =>
        this.ledgerRow(key, ledger, {
          lotId: slice.lotId,
          quantity: -slice.quantity,
          balanceAfter: balances[index],
          unitCost: costOf.get(slice.lotId)!,
        }),
      ),
    );
    if (ledger.type === InventoryTxType.SALE && orderItemId) {
      await this.refreshLineCost(tx, orderItemId);
    }
  }

  /** Raise stock, creating the row if this location has never held the item. One upsert on purpose: a read-then-create lets two receipts both insert and one die on the unique index. */
  private incrementStock(
    tx: Prisma.TransactionClient,
    key: StockKey,
    quantity: number,
  ): Promise<Inventory> {
    return tx.inventory.upsert({
      where: {
        tenantId_locationId_productItemId: {
          tenantId: key.tenantId,
          locationId: key.locationId,
          productItemId: key.productItemId,
        },
      },
      // Named fields, not `...key`: callers pass their whole argument object as the key.
      create: {
        tenantId: key.tenantId,
        locationId: key.locationId,
        productItemId: key.productItemId,
        stock: quantity,
        minStock: 0,
      },
      update: { stock: { increment: quantity } },
    });
  }

  /** `OrderItem.unitCostPrice` = average cost of the units the line actually has out, from its SALE / SALE_REVERSAL rows. */
  private async refreshLineCost(
    tx: Prisma.TransactionClient,
    orderItemId: string,
  ): Promise<void> {
    const rows = await tx.inventoryTransaction.findMany({
      where: {
        orderItemId,
        type: { in: [InventoryTxType.SALE, InventoryTxType.SALE_REVERSAL] },
      },
      select: { quantity: true, unitCost: true },
    });
    await tx.orderItem.update({
      where: { id: orderItemId },
      data: {
        unitCostPrice: averageUnitCost(
          rows.map((row) => ({
            quantity: row.quantity,
            unitCost: Number(row.unitCost ?? 0),
          })),
        ),
      },
    });
  }

  private async currentCostPrice(
    tx: Prisma.TransactionClient,
    productItemId: string,
  ): Promise<Prisma.Decimal> {
    const item = await tx.productItem.findUniqueOrThrow({
      where: { id: productItemId },
      select: { costPrice: true },
    });
    return item.costPrice;
  }

  private async assertSellable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    locationId: string,
  ): Promise<void> {
    const location = await tx.location.findFirst({
      where: { id: locationId, tenantId },
      select: { isSellable: true },
    });
    if (!location) {
      throw new NotFoundException({
        code: ErrorCode.LOCATION_NOT_FOUND,
        message: 'Location not found',
      });
    }
    if (!location.isSellable) {
      throw new BadRequestException({
        code: ErrorCode.LOCATION_NOT_SELLABLE,
        message: 'Stock at a damaged-goods location cannot be held or sold',
      });
    }
  }

  private assertPositive(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException({
        code: ErrorCode.QUANTITY_MUST_BE_POSITIVE,
        message: 'The quantity must be a whole number greater than 0',
      });
    }
  }

  private keyWhere(key: StockKey): Prisma.InventoryWhereInput {
    return {
      tenantId: key.tenantId,
      locationId: key.locationId,
      productItemId: key.productItemId,
    };
  }

  private ledgerRow(
    key: StockKey,
    ledger: LedgerRef,
    row: {
      lotId: string;
      quantity: number;
      balanceAfter: number;
      unitCost: Prisma.Decimal | number;
    },
  ): Prisma.InventoryTransactionCreateManyInput {
    return {
      tenantId: key.tenantId,
      locationId: key.locationId,
      productItemId: key.productItemId,
      type: ledger.type,
      referenceType: ledger.referenceType,
      referenceId: ledger.referenceId,
      createdById: ledger.createdById ?? null,
      note: ledger.note ?? null,
      orderItemId: ledger.orderItemId ?? null,
      ...row,
    };
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
            locationId: inventory.locationId,
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
}
