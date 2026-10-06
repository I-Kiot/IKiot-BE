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
import { actualStockOf, crossedLowStock } from './low-stock';
import { QueryInventoryDto } from './dto/query-inventory.dto';
import { AddProductToLocationDto } from './dto/add-product-to-location.dto';
import type { Inventory, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  InventoryTxType,
  type InventoryRefType,
  type LotSourceType,
} from '../../common/constants/inventory-ledger';
import {
  averageUnitCost,
  planDraw,
  planReturn,
  runningBalances,
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

/** Một dòng không đủ hàng trên kệ để khoá – gửi về client trong `errors` để hiện từng mặt hàng thiếu bao nhiêu. */
export interface ShortStockLine {
  /** SKU (hoặc tên) – chính là `label` mà `packOrder` truyền vào cho dòng đó. */
  label: string;
  needed: number;
  onShelf: number;
}

/** Một dòng đã khoá: hàng tồn sau khi khoá kèm số lượng vừa khoá – đủ để tính cảnh báo sắp hết hàng. */
export interface LockedLine {
  row: Inventory;
  quantity: number;
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

  /** `location` is already the shared `{ id, type, name }` (LOCATION_SELECT); `locationId` is dropped so the response names the place once. `stock` is the total and `actualStock` what is still on the shelf - computed here, never stored. */
  private toResponse(row: InventoryRow) {
    const { locationId, ...rest } = row;
    return { ...rest, actualStock: actualStockOf(row) };
  }

  async findAll(tenantId: string, query: QueryInventoryDto) {
    const where: Prisma.InventoryWhereInput = {
      tenantId,
      ...locationWhere(query),
    };

    if (query.isLowStock) {
      // A row is low when its shelf (stock − locked_stock, as crossedLowStock judges it) is at or under its own threshold; minStock = 0 switches the alert off for that line, so those are excluded rather than matching everything. Prisma can compare a column with a column but not with an expression, so the ids come from SQL and every other filter stays here.
      const low = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "inventories"
        WHERE "tenant_id" = ${tenantId}
          AND "min_stock" > 0
          AND "stock" - "locked_stock" <= "min_stock"`;
      where.id = { in: low.map((row) => row.id) };
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
  //   - Goods packed for an order are locked (2026-10-04): `lockStock` when the order is packed
  //     (CONFIRMED → PACKED), `shipLockedStock` when it moves to SHIPPING - the one step that
  //     lowers `stock`, with the order line on the ledger - and `releaseLockedStock` on any way
  //     out in between. The shelf is `stock − locked_stock` (`actualStockOf`); `deductStock` and
  //     `lockStock` only ever take from the shelf, never from goods packed for someone else.
  //     The fulfillment is the record of who holds the lock - there is no reservation table.
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

  /** Take stock off a shelf - a till sale, a transfer leaving, a stocktake shortage. (A packed order leaves through `shipLockedStock` instead.) Refuses to take more than is on the shelf (`stock - locked_stock >= quantity`, checked inside the UPDATE, because reading the level and then decrementing lets two tills both sell the last item) - goods packed for an order are not for sale. Then draws the lots FIFO. With `ledger.orderItemId` it draws that line's own custom lot first and refreshes the line's cost of goods (SALE). */
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
        AND "stock" - "locked_stock" >= ${args.quantity}`;

    if (taken === 0) {
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `Not enough stock for ${args.label}: ${args.quantity} needed, ${await this.shelfOf(tx, args)} available`,
      });
    }

    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(args),
    });
    await this.drawLots(tx, args, args.quantity, inventory.stock, args.ledger);
    return inventory;
  }

  /**
   * Lock goods on the shelf for an order being packed (CONFIRMED → PACKED). Every line is tried
   * and the short ones are reported together, so whoever packs sees the whole problem at once.
   * The guard (`stock - locked_stock >= quantity`) is inside the UPDATE, like `deductStock`'s,
   * so two orders cannot both pack the last piece. Moves no stock and writes no ledger row: the
   * goods have not left, and the fulfillment is the record of who holds them.
   *
   * Returns each line's row after its lock together with the quantity locked, for
   * `lowStockCrossing(row, -quantity)` - packing empties the shelf just as a sale does. The pair
   * travels together so the caller never has to line two arrays up by index.
   */
  async lockStock(
    tx: Prisma.TransactionClient,
    lines: (StockKey & { quantity: number; label: string })[],
  ): Promise<LockedLine[]> {
    const locked: LockedLine[] = [];
    // Structured, not a sentence: the client renders each short line's numbers itself.
    const short: ShortStockLine[] = [];
    for (const line of lines) {
      this.assertPositive(line.quantity);
      const taken = await tx.$executeRaw`
        UPDATE "inventories"
        SET "locked_stock" = "locked_stock" + ${line.quantity}, "updated_at" = now()
        WHERE "tenant_id" = ${line.tenantId}
          AND "location_id" = ${line.locationId}
          AND "product_item_id" = ${line.productItemId}
          AND "stock" - "locked_stock" >= ${line.quantity}`;
      if (taken === 0) {
        short.push({
          label: line.label,
          needed: line.quantity,
          onShelf: await this.shelfOf(tx, line),
        });
        continue;
      }
      locked.push({
        row: await tx.inventory.findFirstOrThrow({
          where: this.keyWhere(line),
        }),
        quantity: line.quantity,
      });
    }
    if (short.length > 0) {
      // `message` is English for the logs; `errors` is what the client reads (it builds the Vietnamese).
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: `Not enough stock on the shelf to pack - ${short
          .map(
            (s) => `${s.label}: ${s.needed} needed, ${s.onShelf} on the shelf`,
          )
          .join('; ')}`,
        errors: short,
      });
    }
    return locked;
  }

  /** Packed goods leave with their order (PICKED_UP → SHIPPING): `stock` and `locked_stock` drop together, so the shelf is untouched and no low-stock warning is due, then the lots are drawn exactly as `deductStock` draws them. Refuses to ship more than is locked - that means the order was never packed here, or its lock was already shipped or released. */
  async shipLockedStock(
    tx: Prisma.TransactionClient,
    args: StockKey & { quantity: number; label: string; ledger: LedgerRef },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);

    const taken = await tx.$executeRaw`
      UPDATE "inventories"
      SET "stock" = "stock" - ${args.quantity},
          "locked_stock" = "locked_stock" - ${args.quantity},
          "updated_at" = now()
      WHERE "tenant_id" = ${args.tenantId}
        AND "location_id" = ${args.locationId}
        AND "product_item_id" = ${args.productItemId}
        AND "locked_stock" >= ${args.quantity}`;
    if (taken === 0) {
      throw new ConflictException({
        code: ErrorCode.INVENTORY_LOCK_MISMATCH,
        message: `Cannot ship ${args.quantity} of ${args.label}: fewer are locked for orders at this location`,
      });
    }

    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(args),
    });
    await this.drawLots(tx, args, args.quantity, inventory.stock, args.ledger);
    return inventory;
  }

  /** Give a lock back to the shelf - a packed order cancelled, or its quantity lowered, before it ships. `stock` does not change and nothing is written to the ledger, since nothing moved. Same refusal as `shipLockedStock`, for the same reason. */
  async releaseLockedStock(
    tx: Prisma.TransactionClient,
    args: StockKey & { quantity: number; label: string },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);

    const taken = await tx.$executeRaw`
      UPDATE "inventories"
      SET "locked_stock" = "locked_stock" - ${args.quantity}, "updated_at" = now()
      WHERE "tenant_id" = ${args.tenantId}
        AND "location_id" = ${args.locationId}
        AND "product_item_id" = ${args.productItemId}
        AND "locked_stock" >= ${args.quantity}`;
    if (taken === 0) {
      throw new ConflictException({
        code: ErrorCode.INVENTORY_LOCK_MISMATCH,
        message: `Cannot release ${args.quantity} of ${args.label}: fewer are locked for orders at this location`,
      });
    }
    return tx.inventory.findFirstOrThrow({ where: this.keyWhere(args) });
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

  private assertPositive(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException({
        code: ErrorCode.QUANTITY_MUST_BE_POSITIVE,
        message: 'The quantity must be a whole number greater than 0',
      });
    }
  }

  /** For an error message only - the guard that refused is the UPDATE, not this read. */
  private async shelfOf(
    tx: Prisma.TransactionClient,
    key: StockKey,
  ): Promise<number> {
    const current = await tx.inventory.findFirst({
      where: this.keyWhere(key),
      select: { stock: true, lockedStock: true },
    });
    return current ? actualStockOf(current) : 0;
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
            // The shelf, which is what crossed the threshold - not the total.
            stock: actualStockOf(inventory),
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
