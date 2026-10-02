import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { SystemRole } from './../src/common/constants/system-role';
import type { AuthUser } from './../src/common/types/auth-user.type';

// The callers of InventoryService's lot primitives that predate the order journey - imports,
// transfers, stocktakes and the till - driven through their real services against Postgres
// (docker compose up -d). Each step checks the stock, the lots behind it and the ledger.
// smoke.e2e-spec.ts covers these routes too but has not run since the Location schema
// changed the wire format (rewriting it is F-1); until then this is what proves the stock
// paths keep Σ lot.remaining = stock. Creates its own tenant and removes it afterwards.
describe('stock callers on lots (imports, transfers, stocktakes, till)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let movements: StockMovementService;
  let orders: OrderService;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const supplierId = randomUUID();
  const productId = randomUUID();
  const itemId = randomUUID();

  const owner: AuthUser = {
    userId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    roleId: null,
    branchId: null,
    warehouseId: null,
    permissions: new Set(),
    shiftSupervision: null,
    email: null,
    displayName: 'Owner',
    phoneNumber: `callers-${userId}`,
  };

  async function stockAt(locationId: string) {
    const row = await prisma.inventory.findFirst({
      where: { tenantId, locationId, productItemId: itemId },
    });
    const lots = await prisma.inventoryLot.aggregate({
      where: { tenantId, locationId, productItemId: itemId },
      _sum: { remainingQuantity: true },
    });
    // The invariant, checked on every read.
    expect(lots._sum.remainingQuantity ?? 0).toBe(row?.stock ?? 0);
    return row?.stock ?? 0;
  }

  const ledgerOf = (type: string) =>
    prisma.inventoryTransaction.findMany({
      where: { tenantId, type },
      include: { lot: true },
      orderBy: [{ createdAt: 'asc' }, { balanceAfter: 'desc' }],
    });

  async function transfer(quantity: number) {
    const created = await movements.create(owner, {
      movementType: 'EXPORT',
      fromLocationId: warehouseId,
      toLocationId: branchId,
      details: [{ productItemId: itemId, quantity }],
    });
    await movements.open(owner, created.id);
    await movements.close(owner, created.id);
    await movements.ship(owner, created.id);
    return created.id;
  }

  async function stocktake(locationId: string, counted: number) {
    const created = await movements.create(owner, {
      movementType: 'ADJUST',
      fromLocationId: locationId,
      details: [{ productItemId: itemId, receivedQuantity: counted }],
    });
    await movements.approveAdjust(owner, created.id);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    movements = app.get(StockMovementService);
    orders = app.get(OrderService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'callers-e2e' } });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        phoneNumber: owner.phoneNumber,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    for (const [id, type] of [
      [branchId, 'BRANCH'],
      [warehouseId, 'WAREHOUSE'],
    ] as const) {
      await prisma.location.create({
        data: { id, tenantId, name: `${type} callers`, type },
      });
    }
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.warehouse.create({
      data: { id: warehouseId, tenantId, locationId: warehouseId },
    });
    await prisma.supplier.create({
      data: { id: supplierId, tenantId, supplierName: 'NCC callers' },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Ghế' },
    });
    await prisma.productItem.create({
      data: {
        id: itemId,
        tenantId,
        productId,
        productName: 'Ghế',
        productCode: `CALL-${itemId}`,
        sku: `CALL-${itemId}`,
        retailPrice: 500,
        costPrice: 80,
      },
    });
  });

  // Cleanup must never skip app.close(): AppModule holds crons, Redis and Socket.IO open, and a
  // throw here would leave jest waiting on them forever.
  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await app?.close();
    }
  });

  async function cleanup() {
    if (!prisma) return;
    const where = { tenantId };
    await prisma.cashFlow.deleteMany({ where });
    await prisma.inventoryTransaction.deleteMany({ where });
    await prisma.inventoryLot.deleteMany({
      where: { tenantId, parentLotId: { not: null } },
    });
    await prisma.inventoryLot.deleteMany({ where });
    await prisma.stockMovementRequest.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    // Receiving an import links the variant to its supplier.
    await prisma.productItemSupplier.deleteMany({ where: { supplierId } });
    await prisma.supplier.deleteMany({ where });
    await prisma.productItem.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  it('receives an IMPORT as one SUPPLIER lot per line, costed at the import price', async () => {
    const created = await movements.create(owner, {
      movementType: 'IMPORT',
      fromSupplierId: supplierId,
      toLocationId: warehouseId,
      details: [{ productItemId: itemId, quantity: 10, importPrice: 100 }],
    });
    expect(
      (
        await prisma.stockMovementRequest.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).importSource,
    ).toBe('SUPPLIER');
    await movements.receive(owner, created.id, {
      details: [{ productItemId: itemId, receivedQuantity: 10 }],
    });

    expect(await stockAt(warehouseId)).toBe(10);
    const [row] = await ledgerOf('IMPORT');
    expect(row).toMatchObject({ quantity: 10, balanceAfter: 10 });
    expect(row.lot).toMatchObject({ sourceType: 'SUPPLIER', supplierId });
    expect(Number(row.lot.unitCost)).toBe(100);
  });

  it('turns a stocktake surplus into an ADJUSTMENT lot at the cost price', async () => {
    await stocktake(warehouseId, 12);
    expect(await stockAt(warehouseId)).toBe(12);
    const [row] = await ledgerOf('ADJUST');
    expect(row.lot.sourceType).toBe('ADJUSTMENT');
    expect(Number(row.lot.unitCost)).toBe(80);
  });

  it('ships a transfer out of the oldest lot and receives it as child lots', async () => {
    const id = await transfer(4);
    expect(await stockAt(warehouseId)).toBe(8);
    await movements.receive(owner, id, {
      details: [{ productItemId: itemId, receivedQuantity: 4 }],
    });
    expect(await stockAt(branchId)).toBe(4);

    const [arrived] = await ledgerOf('TRANSFER_IN');
    expect(arrived.lot.parentLotId).not.toBeNull();
    expect(arrived.lot.sourceType).toBe('SUPPLIER');
    expect(Number(arrived.lot.unitCost)).toBe(100);
  });

  it('puts a transfer cancelled in transit back into the lots it left', async () => {
    const lotsBefore = await prisma.inventoryLot.count({ where: { tenantId } });
    const id = await transfer(3);
    expect(await stockAt(warehouseId)).toBe(5);
    await movements.cancel(owner, id);
    expect(await stockAt(warehouseId)).toBe(8);
    expect(await prisma.inventoryLot.count({ where: { tenantId } })).toBe(
      lotsBefore,
    );
  });

  it('sells at the till from the lots, costing the line, and takes a return back', async () => {
    const { order } = await orders.create(owner, tenantId, {
      branchId,
      paymentMethod: 'CASH',
      items: [{ productItemId: itemId, quantity: 2 }],
    });
    expect(await stockAt(branchId)).toBe(2);
    expect(order.assigneeId).toBe(userId);

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: order.id },
    });
    const sales = await ledgerOf('SALE');
    expect(sales.every((row) => row.orderItemId === line.id)).toBe(true);
    expect(Number(line.unitCostPrice)).toBe(100);

    await orders.updateStatus(owner, tenantId, order.id, 'RETURNED');
    expect(await stockAt(branchId)).toBe(4);
    const [back] = await ledgerOf('RETURN_GOOD');
    expect(back.orderItemId).toBe(line.id);
  });

  it('draws a stocktake shortage FIFO', async () => {
    await stocktake(branchId, 1);
    expect(await stockAt(branchId)).toBe(1);
  });
});
