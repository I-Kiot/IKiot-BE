import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
  InventoryRefType,
  InventoryTxType,
  type LotSourceType,
} from '../../common/constants/inventory-ledger';
import { canActAt } from '../../common/utils/location-access';
import { requireTenantId } from '../../common/utils/tenant-scope';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { DamagedStockDto } from './dto/damaged-stock.dto';

const DAMAGED_TX_TYPE = {
  mark: InventoryTxType.MARK_DAMAGED,
  repair: InventoryTxType.REPAIRED,
  writeOff: InventoryTxType.WRITE_OFF,
} as const;
import {
  averageUnitCost,
  planDraw,
  planReturn,
  runningBalances,
  type LotSlice,
} from './lot-allocation';
import { assertHoldsStock } from './stockable';

export interface StockKey {
  tenantId: string;
  productItemId: string;
  /** Id địa điểm (Location), cũng là id của Branch hoặc Warehouse tương ứng. */
  locationId: string;
}

export interface LedgerRef {
  type: InventoryTxType;
  referenceType: InventoryRefType;
  referenceId: string;
  createdById?: string | null;
  note?: string | null;
  /** Dòng SALE / SALE_REVERSAL / RETURN_*: trỏ tới dòng đơn để đọc giá vốn hàng bán từ sổ cái. */
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

/** Port từ InventoryService, phục vụ bốn route `/inventory` và các primitive tồn mà Order / StockMovement gọi. Đặt chung vì "chuyện gì xảy ra với tồn và khi nào cảnh báo" là một luật. */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * `location` đã là `{ id, type, name }` chung (LOCATION_SELECT), nên bỏ `locationId`. `stock` là tổng hàng bán được,
   * `actualStock` là phần còn trên kệ, `damagedQuantity` là hàng hỏng tại đó (ngoài `stock`); hai số sau tính lúc đọc, không lưu.
   */
  private toResponse(row: InventoryRow, damagedQuantity = 0) {
    const { locationId, ...rest } = row;
    return { ...rest, actualStock: actualStockOf(row), damagedQuantity };
  }

  private async withDamaged(tenantId: string, rows: InventoryRow[]) {
    const damaged = await this.damagedQuantities(this.prisma, tenantId, {
      locationIds: [...new Set(rows.map((row) => row.locationId))],
      productItemIds: [...new Set(rows.map((row) => row.productItemId))],
    });
    return rows.map((row) =>
      this.toResponse(
        row,
        damaged.get(`${row.locationId}:${row.productItemId}`) ?? 0,
      ),
    );
  }

  async findAll(tenantId: string, query: QueryInventoryDto) {
    const where: Prisma.InventoryWhereInput = {
      tenantId,
      ...locationWhere(query),
    };

    if (query.isLowStock) {
      // Dòng thấp khi kệ (stock − locked_stock) ≤ ngưỡng riêng. minStock = 0 tắt cảnh báo nên loại ra, không khớp tất cả.
      // Prisma không so cột với biểu thức, nên id lấy từ SQL, các điều kiện khác giữ ở đây.
      const low = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "inventories"
        WHERE "tenant_id" = ${tenantId}
          AND "min_stock" > 0
          AND "stock" - "locked_stock" <= "min_stock"`;
      where.id = { in: low.map((row) => row.id) };
    }

    if (query.hasDamaged) {
      // Dòng tồn có lô hỏng còn hàng ở chính địa điểm đó. Dùng index một phần `inventory_lots_damaged_idx`.
      const damaged = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT i."id" FROM "inventories" i
        WHERE i."tenant_id" = ${tenantId}
          AND EXISTS (
            SELECT 1 FROM "inventory_lots" lot
            WHERE lot."tenant_id" = i."tenant_id"
              AND lot."location_id" = i."location_id"
              AND lot."product_item_id" = i."product_item_id"
              AND lot."is_sellable" = false
              AND lot."remaining_quantity" > 0)`;
      const ids = damaged.map((row) => row.id);
      where.AND = [{ id: { in: ids } }];
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
      await this.withDamaged(tenantId, rows),
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
    return (await this.withDamaged(tenantId, [row]))[0];
  }

  /**
   * Bắt đầu nhập một phiên bản tại địa điểm, số 0. Dùng để khai báo "địa điểm này sẽ có hàng này" trước khi hàng về
   * (VD đặt ngưỡng `minStock` cho hàng đang đặt). Phiếu nhập vốn cũng tạo dòng, đây chỉ là đầu mối.
   */
  async addProductToLocation(tenantId: string, dto: AddProductToLocationDto) {
    await resolveLocations(this.prisma, tenantId, [dto.locationId]);

    const productItem = await this.prisma.productItem.findFirst({
      where: { id: dto.productItemId, tenantId },
      select: { id: true, sku: true, itemType: true },
    });
    if (!productItem) {
      throw new NotFoundException({
        code: ErrorCode.PRODUCT_ITEM_NOT_FOUND,
        message: 'Product item not found',
      });
    }
    assertHoldsStock([productItem]);

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

  /** Stop stocking a variant at a location. Refuses while any stock is left there, damaged goods included. */
  async removeProductFromLocation(tenantId: string, id: string) {
    const existing = await this.findRow(tenantId, id);
    if (existing.stock > 0) {
      throw new BadRequestException({
        code: ErrorCode.INVENTORY_STILL_HAS_STOCK,
        message: `Cannot remove this item from the location while ${existing.stock} in stock remain. Transfer or sell them first.`,
      });
    }
    const damaged = (
      await this.damagedQuantities(this.prisma, tenantId, {
        locationIds: [existing.locationId],
        productItemIds: [existing.productItemId],
      })
    ).get(`${existing.locationId}:${existing.productItemId}`);
    if (damaged) {
      throw new BadRequestException({
        code: ErrorCode.INVENTORY_STILL_HAS_STOCK,
        message: `Cannot remove this item from the location while ${damaged} damaged units remain. Repair or write them off first.`,
      });
    }

    await this.prisma.inventory.delete({ where: { id } });
    // `{ success: true }` is what iKiotMS-BE answered here and what the frontend checks.
    return { success: true };
  }

  /**
   * Ba route hàng hỏng trên một dòng tồn (`/inventory/:id/...`). Nhân viên chỉ làm ở nơi mình làm việc (`canActAt`).
   * Chứng từ trong sổ kho là chính dòng inventory (`INVENTORY`, id dòng), kèm người làm và lý do.
   */
  async changeDamaged(
    user: AuthUser,
    id: string,
    action: 'mark' | 'repair' | 'writeOff',
    dto: DamagedStockDto,
  ) {
    const tenantId = requireTenantId(user);
    const row = await this.findRow(tenantId, id);
    if (!canActAt(user, row.location)) {
      throw new ForbiddenException({
        code: ErrorCode.INVENTORY_LOCATION_DENIED,
        message: 'You can only change damaged goods at your own location',
      });
    }
    const args = {
      tenantId,
      locationId: row.locationId,
      productItemId: row.productItemId,
      quantity: dto.quantity,
      label: row.productItem.sku ?? row.productItem.productName ?? id,
      ledger: {
        type: DAMAGED_TX_TYPE[action],
        referenceType: InventoryRefType.INVENTORY,
        referenceId: row.id,
        createdById: user.userId,
        note: dto.note ?? null,
      },
    };
    const after = await this.prisma.$transaction(async (tx) => {
      if (action === 'mark') {
        return this.markDamaged(tx, { ...args, orderItemId: dto.orderItemId });
      }
      if (action === 'repair') return this.repairDamaged(tx, args);
      return this.writeOffDamaged(tx, args);
    });
    // Đánh dấu hỏng làm kệ vơi như bán: có thể vừa chạm ngưỡng cảnh báo.
    if (action === 'mark') {
      await this.notifyLowStock([this.lowStockCrossing(after, -dto.quantity)]);
    }
    return (
      await this.withDamaged(tenantId, [await this.findRow(tenantId, id)])
    )[0];
  }

  // ─── Primitive tồn dùng chung cho Order / StockMovement / Fulfillment / OrderReturn ──
  //
  // Luật chung (schema, docs/order-flow.md):
  //   - Hàng đã đóng gói cho đơn bị khoá (2026-10-04): `lockStock` khi đóng gói (CONFIRMED → PACKED),
  //     `shipLockedStock` khi chuyển SHIPPING (bước duy nhất hạ `stock`, có dòng sổ cái), `releaseLockedStock`
  //     nếu huỷ giữa chừng. Kệ = `stock − locked_stock`; `deductStock` và `lockStock` chỉ lấy từ kệ, không
  //     lấy hàng đã đóng cho người khác. Fulfillment ghi ai đang giữ khoá, không có bảng đặt trước.
  //   - Tồn nằm trong lô: Σ remainingQuantity của lô bán được (isSellable) = inventories.stock, luôn đúng. Lô hỏng
  //     (isSellable = false, 2026-11-26) nằm ngoài stock; không lô nào đổi cờ, đánh dấu hỏng / sửa xong đều tách lô con. Mỗi thay đổi ghi dòng sổ cái
  //     (InventoryTransaction), một dòng cho mỗi lô bị chạm.
  //   - Mọi ghi dùng transaction của người gọi (rollback thì tồn không đổi). Điều kiện chặn thao tác bất khả thi
  //     nằm trong chính UPDATE đó, không đọc rồi mới ghi.
  //   - Luôn ghi dòng inventory trước lô, để hai thao tác đồng thời trên một SKU ở một địa điểm xếp hàng theo khoá
  //     của dòng đó và thấy thay đổi lô của nhau.

  /** Hàng về lần đầu (nhập, thừa kiểm kê): một lô mới, tồn và dòng sổ cái nhập. Không truyền `unitCost` thì lấy giá vốn hiện tại. */
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
      /** `false` = lô hỏng (hàng lỗi xưởng): nằm tại địa điểm nhưng không cộng vào `stock`. Mặc định `true`. */
      isSellable?: boolean;
      ledger: LedgerRef;
    },
  ): Promise<{ inventory: Inventory; lotId: string }> {
    this.assertPositive(args.quantity);
    const sellable = args.isSellable ?? true;
    const unitCost =
      args.unitCost ?? (await this.currentCostPrice(tx, args.productItemId));

    // Lô hỏng vẫn cần dòng inventory (khoá dòng + danh sách tồn hiện số hỏng), nhưng tăng 0.
    const inventory = await this.incrementStock(
      tx,
      args,
      sellable ? args.quantity : 0,
    );
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
        isSellable: sellable,
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
   * Khoá hàng trên kệ cho đơn đang đóng gói (CONFIRMED → PACKED). Thử mọi dòng rồi báo chung các dòng thiếu.
   * Điều kiện `stock - locked_stock >= quantity` nằm trong UPDATE, nên hai đơn không cùng khoá món cuối.
   * Không đổi tồn, không ghi sổ cái (hàng chưa rời kho). Trả từng dòng sau khi khoá kèm số lượng khoá, để gọi
   * `lowStockCrossing(row, -quantity)`: đóng gói cũng làm kệ vơi như bán. Cặp đi chung để khỏi ghép theo index.
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

  /** Đóng gói rời kho (PICKED_UP → SHIPPING): `stock` và `locked_stock` cùng giảm nên kệ không đổi; sau đó trừ lô như `deductStock`. Không giao quá số đang khoá. */
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

  /** Trả khoá về kệ khi huỷ đơn đã đóng gói, hoặc giảm số lượng trước khi giao. Không đổi `stock`, không ghi sổ cái vì hàng chưa đi đâu. Từ chối như `shipLockedStock`. */
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
   * Hàng trả về theo chứng từ đã xuất, về đúng các lô đã rời: phiếu chuyển đã nhận (`drawnBy` là phiếu,
   * `toLocationId` là đích; mỗi đơn vị thành lô con giữ nguồn và giá vốn), phiếu chuyển huỷ giữa đường,
   * đơn đã đóng gói huỷ trước khi bàn giao (cùng địa điểm: về lô gốc), hoặc khách trả (`drawnBy` là dòng đơn,
   * có thể về địa điểm hàng hỏng). Từ chối nếu trả nhiều hơn đã xuất trừ phần đã trả.
   * `ifNeverDrawn` cho chứng từ cũ hơn lô (2026-10-02): không có dòng sổ cái để truy, nên hàng về thành lô mới
   * của nguồn. Bỏ trống nếu không thể xảy ra.
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
      /** `false` = hàng về bị hỏng (RETURN_DAMAGED): luôn thành lô con hỏng, không cộng `stock`, không bao giờ gộp vào lô cha. */
      isSellable?: boolean;
    },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);
    const sellable = args.isSellable ?? true;
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
        isSellable: sellable,
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

    const inventory = await this.incrementStock(
      tx,
      key,
      sellable ? args.quantity : 0,
    );
    const balances = sellable
      ? runningBalances(
          inventory.stock - args.quantity,
          slices.map((slice) => slice.quantity),
        )
      : slices.map(() => inventory.stock);

    const rows: Prisma.InventoryTransactionCreateManyInput[] = [];
    for (const [index, slice] of slices.entries()) {
      const origin = lotById.get(slice.lotId)!;
      let lotId = origin.id;
      // Cộng thẳng vào lô gốc chỉ khi cùng địa điểm VÀ cùng loại: hàng hỏng về không bao giờ vào lô bán được.
      if (
        origin.locationId === args.toLocationId &&
        origin.isSellable === sellable
      ) {
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
            isSellable: sellable,
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

  // ─── Hàng hỏng (2026-11-26): lô `isSellable = false` tại chính địa điểm, ngoài `stock` ─────────────

  /**
   * Phát hiện hỏng trên kệ: rút `quantity` từ kệ như `deductStock` (không lấy hàng đã đóng gói), rồi tách thành lô con
   * hỏng cùng địa điểm. Không có `orderItemId`: chỉ hàng dùng chung. Có: đúng chiếc may riêng cho dòng đơn đó; lô hỏng
   * giữ `orderItemId`, nên sửa xong vẫn về đúng đơn đó, còn trong lúc hỏng đơn đó hiện thiếu hàng ở danh sách cần sản xuất.
   * Dòng sổ cái không mang `orderItemId`: chỉ SALE / RETURN_* mới được tính là hàng của dòng đơn đã đi.
   */
  async markDamaged(
    tx: Prisma.TransactionClient,
    args: StockKey & {
      quantity: number;
      label: string;
      ledger: LedgerRef;
      orderItemId?: string | null;
    },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);
    const ledger = { ...args.ledger, orderItemId: null };
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
        message: `Not enough stock on the shelf to mark ${args.label} damaged: ${args.quantity} needed, ${await this.shelfOf(tx, args)} available`,
      });
    }
    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(args),
    });
    const slices = await this.drawLots(
      tx,
      args,
      args.quantity,
      inventory.stock,
      ledger,
      { exactly: { orderItemId: args.orderItemId ?? null, label: args.label } },
    );
    await this.splitInto(
      tx,
      args,
      slices,
      false,
      ledger,
      slices.map(() => inventory.stock),
    );
    return inventory;
  }

  /** Hàng hỏng sửa xong: rút lô hỏng FIFO, tách thành lô con bán được (giữ giá vốn, ngày nhập), cộng lại `stock`. */
  async repairDamaged(
    tx: Prisma.TransactionClient,
    args: StockKey & { quantity: number; label: string; ledger: LedgerRef },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);
    const ledger = { ...args.ledger, orderItemId: null };
    // Khoá dòng inventory trước lô; thiếu hàng hỏng thì drawLots ném và cả transaction (kể cả phần tăng này) rollback.
    const inventory = await this.incrementStock(tx, args, args.quantity);
    const before = inventory.stock - args.quantity;
    const slices = await this.drawLots(
      tx,
      args,
      args.quantity,
      before,
      ledger,
      { damaged: { label: args.label } },
    );
    await this.splitInto(
      tx,
      args,
      slices,
      true,
      ledger,
      runningBalances(
        before,
        slices.map((slice) => slice.quantity),
      ),
    );
    return inventory;
  }

  /** Huỷ / thanh lý hàng hỏng: rút lô hỏng FIFO, hàng rời khỏi sổ. `stock` không đổi. */
  async writeOffDamaged(
    tx: Prisma.TransactionClient,
    args: StockKey & { quantity: number; label: string; ledger: LedgerRef },
  ): Promise<Inventory> {
    this.assertPositive(args.quantity);
    const ledger = { ...args.ledger, orderItemId: null };
    const locked = await tx.$executeRaw`
      UPDATE "inventories" SET "updated_at" = now()
      WHERE "tenant_id" = ${args.tenantId}
        AND "location_id" = ${args.locationId}
        AND "product_item_id" = ${args.productItemId}`;
    if (locked === 0) {
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_DAMAGED_STOCK,
        message: `No damaged stock of ${args.label} here`,
      });
    }
    const inventory = await tx.inventory.findFirstOrThrow({
      where: this.keyWhere(args),
    });
    await this.drawLots(tx, args, args.quantity, inventory.stock, ledger, {
      damaged: { label: args.label },
    });
    return inventory;
  }

  /** Số hàng hỏng còn lại theo (địa điểm, SKU), cộng từ lô lúc đọc. Khoá map: `${locationId}:${productItemId}`. */
  async damagedQuantities(
    reader: Pick<Prisma.TransactionClient, 'inventoryLot'>,
    tenantId: string,
    where: { locationIds?: string[]; productItemIds?: string[] },
  ): Promise<Map<string, number>> {
    const rows = await reader.inventoryLot.groupBy({
      by: ['locationId', 'productItemId'],
      where: {
        tenantId,
        isSellable: false,
        remainingQuantity: { gt: 0 },
        ...(where.locationIds ? { locationId: { in: where.locationIds } } : {}),
        ...(where.productItemIds
          ? { productItemId: { in: where.productItemIds } }
          : {}),
      },
      _sum: { remainingQuantity: true },
    });
    return new Map(
      rows.map((row) => [
        `${row.locationId}:${row.productItemId}`,
        row._sum.remainingQuantity ?? 0,
      ]),
    );
  }

  /** Ghi dòng sổ cái. Mọi thay đổi tồn đi qua các primitive trên; ghi trực tiếp chỉ cho dòng không đổi tồn. */
  async writeLedger(
    tx: Prisma.TransactionClient,
    rows: Prisma.InventoryTransactionCreateManyInput[],
  ): Promise<void> {
    if (rows.length > 0)
      await tx.inventoryTransaction.createMany({ data: rows });
  }

  // ─── Primitive internals ────────────────────────────────────────────────────

  /**
   * Draw `quantity` from the lots after `inventories.stock` has already been lowered to `stockAfter`.
   * Mặc định chỉ chạm lô bán được: đây là đường duy nhất hàng rời lô, nên bán / đóng gói / chuyển kho / kiểm kê không
   * thể lấy phải hàng hỏng. `damaged` rút lô hỏng (sửa xong, huỷ): `stock` không đổi, mọi lô hỏng rút được FIFO kể cả
   * lô may riêng, và thiếu là lỗi người dùng chứ không phải lệch dữ liệu.
   */
  private async drawLots(
    tx: Prisma.TransactionClient,
    key: StockKey,
    quantity: number,
    stockAfter: number,
    ledger: LedgerRef,
    options: {
      /** Rút lô hỏng (sửa xong, huỷ) thay vì lô bán được. */
      damaged?: { label: string };
      /** Chỉ đúng lô của một dòng đơn (`null` = chỉ lô dùng chung), thiếu là lỗi người dùng. Đánh dấu hỏng dùng. */
      exactly?: { orderItemId: string | null; label: string };
    } = {},
  ): Promise<LotSlice[]> {
    const { damaged, exactly } = options;
    const sellable = !damaged;
    const orderItemId = exactly
      ? exactly.orderItemId
      : damaged
        ? null
        : (ledger.orderItemId ?? null);
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
        AND "is_sellable" = ${sellable}
        AND (
          CASE WHEN ${!!exactly} THEN "order_item_id" IS NOT DISTINCT FROM ${orderItemId}::text
               ELSE (${!sellable} OR "order_item_id" IS NULL OR "order_item_id" = ${orderItemId}::text)
          END)
      FOR UPDATE`;

    const slices = planDraw(
      lots.map((lot) => ({
        id: lot.id,
        remainingQuantity: lot.remaining_quantity,
        receivedAt: lot.received_at,
        // Hàng hỏng không giữ cho dòng đơn nào khi rút: lô nào cũng sửa / huỷ được. `exactly` đã lọc trong SQL.
        orderItemId: damaged || exactly ? null : lot.order_item_id,
      })),
      quantity,
      exactly ? null : orderItemId,
    );
    if (!slices && exactly) {
      const have = lots.reduce((sum, lot) => sum + lot.remaining_quantity, 0);
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: exactly.orderItemId
          ? `Not enough of ${exactly.label} made for that order line here: ${quantity} needed, ${have} available`
          : `Not enough shared stock of ${exactly.label} on the shelf: ${quantity} needed, ${have} available (the rest is made for specific orders)`,
      });
    }
    if (!slices && damaged) {
      const have = lots.reduce((sum, lot) => sum + lot.remaining_quantity, 0);
      throw new BadRequestException({
        code: ErrorCode.INSUFFICIENT_DAMAGED_STOCK,
        message: `Not enough damaged stock for ${damaged.label}: ${quantity} needed, ${have} damaged here`,
      });
    }
    if (!slices) {
      // `inventories.stock` covered it, the lots did not: Σ lot.remaining has drifted from stock.
      throw new InternalServerErrorException({
        code: ErrorCode.INVENTORY_LOT_SHORTAGE,
        message: `The lots of ${key.productItemId} at ${key.locationId} hold less than its stock - cannot draw ${quantity}`,
      });
    }

    const costOf = new Map(lots.map((lot) => [lot.id, lot.unit_cost]));
    const balances = sellable
      ? runningBalances(
          stockAfter + quantity,
          slices.map((slice) => -slice.quantity),
        )
      : slices.map(() => stockAfter);
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
    return slices;
  }

  /**
   * Tách các phần vừa rút thành lô con cùng địa điểm, loại `isSellable`, giữ nguồn, giá vốn và ngày nhập của lô cha
   * (FIFO và giá vốn không đổi qua lần hỏng / sửa). Mỗi lô con một dòng sổ cái dương.
   */
  private async splitInto(
    tx: Prisma.TransactionClient,
    key: StockKey,
    slices: LotSlice[],
    isSellable: boolean,
    ledger: LedgerRef,
    balances: number[],
  ): Promise<void> {
    const parents = await tx.inventoryLot.findMany({
      where: { id: { in: slices.map((slice) => slice.lotId) } },
    });
    const parentById = new Map(parents.map((lot) => [lot.id, lot]));
    const rows: Prisma.InventoryTransactionCreateManyInput[] = [];
    for (const [index, slice] of slices.entries()) {
      const parent = parentById.get(slice.lotId)!;
      const child = await tx.inventoryLot.create({
        data: {
          tenantId: parent.tenantId,
          locationId: parent.locationId,
          productItemId: parent.productItemId,
          sourceType: parent.sourceType,
          supplierId: parent.supplierId,
          importItemId: parent.importItemId,
          productionRequestItemId: parent.productionRequestItemId,
          orderItemId: parent.orderItemId,
          parentLotId: parent.id,
          unitCost: parent.unitCost,
          receivedQuantity: slice.quantity,
          remainingQuantity: slice.quantity,
          receivedAt: parent.receivedAt,
          isSellable,
        },
        select: { id: true },
      });
      rows.push(
        this.ledgerRow(key, ledger, {
          lotId: child.id,
          quantity: slice.quantity,
          balanceAfter: balances[index],
          unitCost: parent.unitCost,
        }),
      );
    }
    await this.writeLedger(tx, rows);
  }

  /** Tăng tồn, tạo dòng nếu địa điểm chưa có món này. Cố ý dùng upsert: đọc rồi tạo thì hai phiếu nhập có thể cùng chèn và một cái chết trên unique index. */
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
