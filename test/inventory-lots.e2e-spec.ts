import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import {
  OrderItemStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
import { ErrorCode } from './../src/common/errors/error-codes';

// Gọi primitive tồn kho của InventoryService trên Postgres thật (docker compose up -d): lô, sổ kho,
// và bất biến mọi thao tác phải giữ - Σ remaining của lô bán được = stock (lô hỏng nằm ngoài). Đóng gói khóa hàng khỏi kệ
// (lockStock, locked_stock); hàng chỉ rời tồn khi đơn chuyển sang SHIPPING (shipLockedStock).
// Tự tạo tenant riêng và xóa mọi thứ đã ghi, nên chạy lại được.
describe('InventoryService stock primitives (lots, ledger)', () => {
  let prisma: PrismaService;
  let inventory: InventoryService;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const branchId = randomUUID();
  const otherId = randomUUID();
  const productId = randomUUID();
  const itemId = randomUUID();
  const customerId = randomUUID();
  const orders = [randomUUID(), randomUUID(), randomUUID()];
  const lines = [randomUUID(), randomUUID(), randomUUID()];
  const key = { tenantId, locationId: branchId, productItemId: itemId };
  const ledger = (type: InventoryTxType) => ({
    type,
    referenceType: InventoryRefType.STOCK_MOVEMENT,
    referenceId: 'test',
    createdById: userId,
  });

  const run = <T>(fn: (tx: any) => Promise<T>) => prisma.$transaction(fn);

  async function assertInvariants() {
    const rows = await prisma.inventory.findMany({ where: { tenantId } });
    for (const row of rows) {
      // Chỉ lô bán được: lô hỏng (isSellable = false) nằm ngoài stock.
      const lots = await prisma.inventoryLot.aggregate({
        where: {
          tenantId,
          locationId: row.locationId,
          productItemId: row.productItemId,
          isSellable: true,
        },
        _sum: { remainingQuantity: true },
      });
      expect(lots._sum.remainingQuantity ?? 0).toBe(row.stock);
      expect(row.lockedStock).toBeGreaterThanOrEqual(0);
      expect(row.lockedStock).toBeLessThanOrEqual(row.stock);
    }
  }

  const stockRow = () =>
    prisma.inventory.findFirstOrThrow({ where: { ...key } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        InventoryService,
        { provide: NotificationService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'lots-e2e' } });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        phoneNumber: `lots-${userId}`,
        systemRole: 'TENANT_OWNER',
      },
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN lots', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: {
        id: otherId,
        tenantId,
        name: 'Kho 2',
        type: 'WAREHOUSE',
      },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Bàn' },
    });
    await prisma.productItem.create({
      data: {
        id: itemId,
        tenantId,
        productId,
        productName: 'Bàn',
        productCode: `LOT-${itemId}`,
        retailPrice: 1000,
        costPrice: 50,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    for (const [index, orderId] of orders.entries()) {
      await prisma.order.create({
        data: {
          id: orderId,
          code: `LOTS-${orderId}`,
          tenantId,
          branchId,
          customerId,
          userId,
          assigneeId: userId,
          status: OrderStatus.CONFIRMED,
          confirmedAt: new Date(Date.UTC(2026, 9, 1 + index)),
          grandTotal: 0,
          items: {
            create: {
              id: lines[index],
              productItemId: itemId,
              quantity: 3,
              listUnitPrice: 1000,
              unitPrice: 1000,
              lineTotal: 3000,
              status: OrderItemStatus.PENDING,
              sourceLocationId: branchId,
            },
          },
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({
      where: { tenantId, parentLotId: { not: null } },
    });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('opens lots with their cost and an inbound ledger row each', async () => {
    await run((tx) =>
      inventory.openLot(tx, {
        ...key,
        quantity: 2,
        unitCost: 100,
        sourceType: LotSourceType.SUPPLIER,
        receivedAt: new Date(Date.UTC(2026, 8, 1)),
        ledger: ledger(InventoryTxType.IMPORT),
      }),
    );
    await run((tx) =>
      inventory.openLot(tx, {
        ...key,
        quantity: 3,
        unitCost: 200,
        sourceType: LotSourceType.WORKSHOP,
        receivedAt: new Date(Date.UTC(2026, 8, 2)),
        ledger: ledger(InventoryTxType.IMPORT),
      }),
    );

    const row = await stockRow();
    expect(row.stock).toBe(5);
    const ledgerRows = await prisma.inventoryTransaction.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
    expect(ledgerRows.map((r) => r.balanceAfter)).toEqual([2, 5]);
    await assertInvariants();
  });

  // Hàng rời kệ kèm dòng đơn trong sổ kho (bán quầy cũng đi đường này).
  const shipLine = (orderItemId: string) =>
    run((tx) =>
      inventory.deductStock(tx, {
        ...key,
        quantity: 3,
        label: 'Bàn',
        ledger: {
          type: InventoryTxType.SALE,
          referenceType: InventoryRefType.ORDER,
          referenceId: 'ship',
          orderItemId,
          createdById: userId,
        },
      }),
    );
  let shipped = '';

  it('never sells below zero when several orders ship the last items at once', async () => {
    const attempts = await Promise.allSettled(lines.map(shipLine));
    // Có 5 trong kho, ba dòng mỗi dòng 3: chỉ một dòng vừa.
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const refused = attempts.find((a) => a.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason.response.code).toBe(
      ErrorCode.INSUFFICIENT_STOCK,
    );
    expect((await stockRow()).stock).toBe(2);
    shipped = (
      await prisma.inventoryTransaction.findFirstOrThrow({
        where: { tenantId, type: InventoryTxType.SALE },
      })
    ).orderItemId!;
    await assertInvariants();
  });

  it('ships FIFO by lot, one SALE row per lot, and costs the line from them', async () => {
    const sales = await prisma.inventoryTransaction.findMany({
      where: { tenantId, type: InventoryTxType.SALE },
      include: { lot: true },
      orderBy: { balanceAfter: 'desc' },
    });
    // Lô 2 @100 (cũ hơn) hết trước, rồi tới 1 @200.
    expect(
      sales.map((s) => [s.quantity, Number(s.lot.unitCost), s.balanceAfter]),
    ).toEqual([
      [-2, 100, 3],
      [-1, 200, 2],
    ]);
    expect(sales.every((s) => s.orderItemId === shipped)).toBe(true);
    const line = await prisma.orderItem.findUniqueOrThrow({
      where: { id: shipped },
    });
    expect(Number(line.unitCostPrice)).toBe(133.33);
  });

  it('puts a returned sale back into the very lots it left', async () => {
    const holder = shipped;

    await run((tx) =>
      inventory.returnDrawn(tx, {
        tenantId,
        productItemId: itemId,
        toLocationId: branchId,
        quantity: 3,
        drawnBy: { orderItemId: holder },
        ledger: {
          type: InventoryTxType.SALE_REVERSAL,
          referenceType: InventoryRefType.ORDER_RETURN,
          referenceId: 'r1',
        },
      }),
    );
    expect((await stockRow()).stock).toBe(5);
    expect(await prisma.inventoryLot.count({ where: { tenantId } })).toBe(2);
    const line = await prisma.orderItem.findUniqueOrThrow({
      where: { id: holder },
    });
    expect(line.unitCostPrice).toBeNull();

    // Dòng đó không còn hàng nào đi ra nữa.
    await expect(
      run((tx) =>
        inventory.returnDrawn(tx, {
          tenantId,
          productItemId: itemId,
          toLocationId: branchId,
          quantity: 1,
          drawnBy: { orderItemId: holder },
          ledger: {
            type: InventoryTxType.SALE_REVERSAL,
            referenceType: InventoryRefType.ORDER_RETURN,
            referenceId: 'r1',
          },
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.INVENTORY_LOT_SHORTAGE },
    });
    await assertInvariants();
  });

  it('moves goods between locations as child lots that keep their origin and cost', async () => {
    const transfer = {
      referenceType: InventoryRefType.STOCK_MOVEMENT,
      referenceId: 'move-1',
      createdById: userId,
    };
    await run((tx) =>
      inventory.deductStock(tx, {
        ...key,
        quantity: 1,
        label: 'Bàn',
        ledger: { ...transfer, type: InventoryTxType.TRANSFER_OUT },
      }),
    );
    await run((tx) =>
      inventory.returnDrawn(tx, {
        tenantId,
        productItemId: itemId,
        toLocationId: otherId,
        quantity: 1,
        drawnBy: transfer,
        ledger: { ...transfer, type: InventoryTxType.TRANSFER_IN },
      }),
    );
    const child = await prisma.inventoryLot.findFirstOrThrow({
      where: { tenantId, locationId: otherId },
      include: { parentLot: true },
    });
    expect(child.parentLot).not.toBeNull();
    expect(Number(child.unitCost)).toBe(Number(child.parentLot!.unitCost));
    expect(child.receivedAt).toEqual(child.parentLot!.receivedAt);
    expect(child.sourceType).toBe(child.parentLot!.sourceType);
    await assertInvariants();
  });

  // Đóng gói → vận chuyển (2026-10-04). Ở đây chi nhánh giữ 4, chưa khóa gì.
  const lock = (quantity: number) =>
    run((tx) => inventory.lockStock(tx, [{ ...key, quantity, label: 'Bàn' }]));
  const ledgerCount = () =>
    prisma.inventoryTransaction.count({ where: { tenantId } });

  it('locks packed goods off the shelf without moving stock or writing the ledger', async () => {
    expect(await stockRow()).toMatchObject({ stock: 4, lockedStock: 0 });
    const before = await ledgerCount();

    await lock(3);
    expect(await stockRow()).toMatchObject({ stock: 4, lockedStock: 3 });
    expect(await ledgerCount()).toBe(before);

    // Chỉ phần trên kệ (1) được bán hoặc chuyển; 3 cái đã đóng gói thì không.
    await expect(
      run((tx) =>
        inventory.deductStock(tx, {
          ...key,
          quantity: 2,
          label: 'Bàn',
          ledger: ledger(InventoryTxType.TRANSFER_OUT),
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.INSUFFICIENT_STOCK },
    });
    await assertInvariants();
  });

  it('refuses to pack beyond the shelf, naming every short line and locking none of them', async () => {
    await expect(
      run((tx) =>
        inventory.lockStock(tx, [
          { ...key, quantity: 1, label: 'Bàn A' },
          { ...key, quantity: 5, label: 'Bàn B' },
          { ...key, quantity: 7, label: 'Bàn C' },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: expect.stringMatching(/Bàn B.*Bàn C/),
      },
    });
    // Transaction rollback nên dòng vừa được cũng không bị khóa lại.
    expect((await stockRow()).lockedStock).toBe(3);
  });

  it('never packs the last piece twice when two orders verify at once', async () => {
    const attempts = await Promise.allSettled([lock(1), lock(1)]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(await stockRow()).toMatchObject({ stock: 4, lockedStock: 4 });
  });

  it('gives a lock back to the shelf, and never more than is locked', async () => {
    await run((tx) =>
      inventory.releaseLockedStock(tx, { ...key, quantity: 1, label: 'Bàn' }),
    );
    expect(await stockRow()).toMatchObject({ stock: 4, lockedStock: 3 });
    await expect(
      run((tx) =>
        inventory.releaseLockedStock(tx, {
          ...key,
          quantity: 4,
          label: 'Bàn',
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.INVENTORY_LOCK_MISMATCH },
    });
  });

  it('ships locked goods: stock and lock drop together, the lots are drawn with the line on the ledger', async () => {
    const before = await ledgerCount();
    await run((tx) =>
      inventory.shipLockedStock(tx, {
        ...key,
        quantity: 3,
        label: 'Bàn',
        ledger: {
          type: InventoryTxType.SALE,
          referenceType: InventoryRefType.ORDER,
          referenceId: 'ship-locked',
          orderItemId: lines[1],
          createdById: userId,
        },
      }),
    );
    expect(await stockRow()).toMatchObject({ stock: 1, lockedStock: 0 });
    const sales = await prisma.inventoryTransaction.findMany({
      where: { tenantId, referenceId: 'ship-locked' },
    });
    expect(sales.reduce((sum, row) => sum + row.quantity, 0)).toBe(-3);
    expect(await ledgerCount()).toBeGreaterThan(before);

    // Không còn gì bị khóa nên không còn gì để giao theo kiện đã đóng.
    await expect(
      run((tx) =>
        inventory.shipLockedStock(tx, {
          ...key,
          quantity: 1,
          label: 'Bàn',
          ledger: ledger(InventoryTxType.SALE),
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.INVENTORY_LOCK_MISMATCH },
    });
    await assertInvariants();
  });

  it('judges low stock on the shelf, not the total', async () => {
    await run((tx) =>
      inventory.openLot(tx, {
        ...key,
        quantity: 5,
        sourceType: LotSourceType.SUPPLIER,
        ledger: ledger(InventoryTxType.IMPORT),
      }),
    );
    await prisma.inventory.updateMany({ where: key, data: { minStock: 4 } });
    const low = () =>
      inventory.findAll(tenantId, {
        page: 1,
        limit: 20,
        isLowStock: true,
      });
    expect((await low()).data).toHaveLength(0);

    // Tổng 6, 3 đã đóng gói: tổng vượt 4 nhưng kệ (3) thì không.
    const [{ row }] = await lock(3);
    expect(inventory.lowStockCrossing(row, -3)).not.toBeNull();
    const { data } = await low();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ stock: 6, lockedStock: 3, actualStock: 3 });

    await run((tx) =>
      inventory.releaseLockedStock(tx, { ...key, quantity: 3, label: 'Bàn' }),
    );
    await prisma.inventory.updateMany({ where: key, data: { minStock: 0 } });
  });

  it('is backed by the database: locked_stock can never exceed stock', async () => {
    await expect(
      prisma.inventory.updateMany({ where: key, data: { lockedStock: 99 } }),
    ).rejects.toThrow();
  });

  // Hàng hỏng (2026-11-26): lô isSellable = false tại chính địa điểm, ngoài stock. Ở đây chi nhánh giữ 6, chưa khoá gì.
  describe('damaged lots', () => {
    const damagedHere = async () =>
      (
        await prisma.inventoryLot.aggregate({
          where: { ...key, isSellable: false },
          _sum: { remainingQuantity: true },
        })
      )._sum.remainingQuantity ?? 0;
    const manual = (type: InventoryTxType) => ({
      type,
      referenceType: InventoryRefType.INVENTORY,
      referenceId: 'damaged-test',
      createdById: userId,
    });

    it('marks shelf goods damaged as child lots that leave stock', async () => {
      expect(await stockRow()).toMatchObject({ stock: 6, lockedStock: 0 });
      await run((tx) =>
        inventory.markDamaged(tx, {
          ...key,
          quantity: 2,
          label: 'Bàn',
          ledger: manual(InventoryTxType.MARK_DAMAGED),
        }),
      );
      expect((await stockRow()).stock).toBe(4);
      expect(await damagedHere()).toBe(2);

      const children = await prisma.inventoryLot.findMany({
        where: { ...key, isSellable: false },
        include: { parentLot: true },
      });
      for (const child of children) {
        expect(child.parentLot?.isSellable).toBe(true);
        expect(Number(child.unitCost)).toBe(Number(child.parentLot!.unitCost));
        expect(child.receivedAt).toEqual(child.parentLot!.receivedAt);
      }
      const rows = await prisma.inventoryTransaction.findMany({
        where: { tenantId, type: InventoryTxType.MARK_DAMAGED },
      });
      expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(0);
      // balanceAfter là stock (chỉ hàng bán được) - dòng vào lô hỏng không làm nó tăng lại.
      expect(Math.min(...rows.map((row) => row.balanceAfter))).toBe(4);
      expect(Math.max(...rows.map((row) => row.balanceAfter))).toBeLessThan(6);
      await assertInvariants();
    });

    it('never sells, packs or marks more than the sellable shelf', async () => {
      await expect(
        run((tx) =>
          inventory.markDamaged(tx, {
            ...key,
            quantity: 5,
            label: 'Bàn',
            ledger: manual(InventoryTxType.MARK_DAMAGED),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_STOCK },
      });

      await run((tx) =>
        inventory.deductStock(tx, {
          ...key,
          quantity: 4,
          label: 'Bàn',
          ledger: { ...ledger(InventoryTxType.SALE), referenceId: 'sell-all' },
        }),
      );
      // 2 hỏng vẫn nằm đó, nhưng kệ đã hết: không bán, không đóng gói được.
      await expect(
        run((tx) =>
          inventory.deductStock(tx, {
            ...key,
            quantity: 1,
            label: 'Bàn',
            ledger: ledger(InventoryTxType.SALE),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_STOCK },
      });
      await expect(lock(1)).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_STOCK },
      });
      const sold = await prisma.inventoryTransaction.findMany({
        where: { tenantId, referenceId: 'sell-all' },
        include: { lot: true },
      });
      expect(sold.every((row) => row.lot.isSellable)).toBe(true);
      expect(await damagedHere()).toBe(2);
      await assertInvariants();
    });

    it('repairs damaged goods back onto the shelf with their cost and date', async () => {
      await run((tx) =>
        inventory.repairDamaged(tx, {
          ...key,
          quantity: 1,
          label: 'Bàn',
          ledger: manual(InventoryTxType.REPAIRED),
        }),
      );
      expect((await stockRow()).stock).toBe(1);
      expect(await damagedHere()).toBe(1);
      const repaired = await prisma.inventoryLot.findFirstOrThrow({
        where: { ...key, isSellable: true, parentLot: { isSellable: false } },
        include: { parentLot: true },
      });
      expect(Number(repaired.unitCost)).toBe(
        Number(repaired.parentLot!.unitCost),
      );
      expect(repaired.receivedAt).toEqual(repaired.parentLot!.receivedAt);
      await assertInvariants();
    });

    it('writes off damaged goods, never more than there are', async () => {
      await expect(
        run((tx) =>
          inventory.writeOffDamaged(tx, {
            ...key,
            quantity: 2,
            label: 'Bàn',
            ledger: manual(InventoryTxType.WRITE_OFF),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_DAMAGED_STOCK },
      });
      await run((tx) =>
        inventory.writeOffDamaged(tx, {
          ...key,
          quantity: 1,
          label: 'Bàn',
          ledger: manual(InventoryTxType.WRITE_OFF),
        }),
      );
      expect(await damagedHere()).toBe(0);
      expect((await stockRow()).stock).toBe(1);
      await expect(
        run((tx) =>
          inventory.repairDamaged(tx, {
            ...key,
            quantity: 1,
            label: 'Bàn',
            ledger: manual(InventoryTxType.REPAIRED),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_DAMAGED_STOCK },
      });
      // Rollback: lần sửa bị từ chối không để lại stock tăng.
      expect((await stockRow()).stock).toBe(1);
      await assertInvariants();
    });

    it('takes a damaged return back at the same location as a new damaged lot, never into the lot it left', async () => {
      const line = lines[2];
      await run((tx) =>
        inventory.deductStock(tx, {
          ...key,
          quantity: 1,
          label: 'Bàn',
          ledger: { ...ledger(InventoryTxType.SALE), orderItemId: line },
        }),
      );

      await run((tx) =>
        inventory.returnDrawn(tx, {
          tenantId,
          productItemId: itemId,
          toLocationId: branchId,
          quantity: 1,
          drawnBy: { orderItemId: line },
          isSellable: false,
          ledger: {
            ...ledger(InventoryTxType.RETURN_DAMAGED),
            referenceType: InventoryRefType.ORDER_RETURN,
          },
        }),
      );
      expect((await stockRow()).stock).toBe(0);
      expect(await damagedHere()).toBe(1);
      // Không lô bán được nào tăng lại: assertInvariants (Σ lô bán được = stock = 0) bắt đúng lỗi gộp vào lô cha.
      const back = await prisma.inventoryLot.findFirstOrThrow({
        where: {
          ...key,
          isSellable: false,
          parentLot: { isSellable: true },
          transactions: { some: { type: InventoryTxType.RETURN_DAMAGED } },
        },
      });
      expect(back.remainingQuantity).toBe(1);
      await assertInvariants();
    });

    it('opens a defect lot without touching stock', async () => {
      await run((tx) =>
        inventory.openLot(tx, {
          ...key,
          quantity: 2,
          unitCost: 80,
          sourceType: LotSourceType.WORKSHOP,
          isSellable: false,
          ledger: ledger(InventoryTxType.DEFECT),
        }),
      );
      expect((await stockRow()).stock).toBe(0);
      expect(await damagedHere()).toBe(3);
      await assertInvariants();
    });

    it('lists the damaged count, filters by it, and refuses to drop a line that still holds damaged goods', async () => {
      const { data } = await inventory.findAll(tenantId, {
        page: 1,
        limit: 20,
        hasDamaged: true,
      });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ stock: 0, damagedQuantity: 3 });
      await expect(
        inventory.removeProductFromLocation(tenantId, data[0].id),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INVENTORY_STILL_HAS_STOCK },
      });
    });

    it('marks a piece made for one order damaged only when that order line is named, and it goes back to that order when repaired', async () => {
      const line = lines[0];
      await run((tx) =>
        inventory.openLot(tx, {
          ...key,
          quantity: 1,
          unitCost: 300,
          sourceType: LotSourceType.WORKSHOP,
          orderItemId: line,
          ledger: ledger(InventoryTxType.IMPORT),
        }),
      );
      expect((await stockRow()).stock).toBe(1);

      // Kệ có 1 nhưng là của đơn khác: không có hàng dùng chung để đánh dấu - 400 rõ ràng, không phải 500.
      await expect(
        run((tx) =>
          inventory.markDamaged(tx, {
            ...key,
            quantity: 1,
            label: 'Bàn',
            ledger: manual(InventoryTxType.MARK_DAMAGED),
          }),
        ),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.INSUFFICIENT_STOCK },
      });
      expect((await stockRow()).stock).toBe(1);

      await run((tx) =>
        inventory.markDamaged(tx, {
          ...key,
          quantity: 1,
          label: 'Bàn',
          orderItemId: line,
          ledger: manual(InventoryTxType.MARK_DAMAGED),
        }),
      );
      expect((await stockRow()).stock).toBe(0);
      const damagedCustom = await prisma.inventoryLot.findFirstOrThrow({
        where: { ...key, isSellable: false, orderItemId: line },
      });
      expect(damagedCustom.remainingQuantity).toBe(1);
      // Sổ cái không gắn dòng đơn: lần trả hàng sau của dòng này không được coi đây là hàng đã giao.
      expect(
        await prisma.inventoryTransaction.count({
          where: {
            tenantId,
            type: InventoryTxType.MARK_DAMAGED,
            orderItemId: { not: null },
          },
        }),
      ).toBe(0);

      // Sửa xong rút lô hỏng theo FIFO: lô cũ nhất là hàng dùng chung, nên sửa 4 để chắc chạm cả chiếc may riêng.
      await run((tx) =>
        inventory.repairDamaged(tx, {
          ...key,
          quantity: 4,
          label: 'Bàn',
          ledger: manual(InventoryTxType.REPAIRED),
        }),
      );
      const back = await prisma.inventoryLot.findFirstOrThrow({
        where: {
          ...key,
          isSellable: true,
          orderItemId: line,
          parentLotId: damagedCustom.id,
        },
      });
      expect(back.remainingQuantity).toBe(1);
      await assertInvariants();
    });
  });
});
