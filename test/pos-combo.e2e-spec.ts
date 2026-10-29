import 'dotenv/config';
import { randomUUID } from 'crypto';
import { HttpException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { ProductService } from './../src/modules/products/products.service';
import { SystemRole } from './../src/common/constants/system-role';
import type { AuthUser } from './../src/common/types/auth-user.type';

// Bán một COMBO ở quầy (POST /orders/pos) trên Postgres thật (docker compose up -d), và số bộ
// combo mà ô tìm kiếm của quầy hiển thị. Combo "Bộ phòng ăn" = 1 Bàn + 4 Ghế + 1 Lắp đặt (dịch vụ).
// Tự tạo tenant riêng và dọn sạch sau khi chạy.
describe('till sale of a combo (POST /orders/pos) and combo availability in search', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let movements: StockMovementService;
  let orders: OrderService;
  let products: ProductService;

  const tenantId = randomUUID();
  const userId = randomUUID();
  const branchId = randomUUID();
  const tableId = randomUUID();
  const chairId = randomUUID();
  const installId = randomUUID();
  const comboId = randomUUID();

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
    phoneNumber: `poscombo-${userId}`,
  };

  const inventoryOf = (productItemId: string) =>
    prisma.inventory.findFirst({
      where: { tenantId, locationId: branchId, productItemId },
    });

  const stockOf = async (productItemId: string) =>
    (await inventoryOf(productItemId))?.stock ?? 0;

  async function setStock(productItemId: string, counted: number) {
    const created = await movements.create(owner, {
      movementType: 'ADJUST',
      fromLocationId: branchId,
      details: [{ productItemId, receivedQuantity: counted }],
    });
    await movements.approveAdjust(owner, created.id);
  }

  /** Số bộ combo mà ô tìm kiếm của quầy báo ở chi nhánh. */
  async function comboAsSearched() {
    const result = await products.search(tenantId, {
      page: 1,
      limit: 20,
      locationId: branchId,
      locationType: 'BRANCH',
    });
    const item = result.data
      .flatMap((product) => product.items)
      .find((row) => row.id === comboId);
    return item!;
  }

  const sellCombo = (
    quantity = 1,
    extra: { productItemId: string; quantity: number }[] = [],
  ) =>
    orders.createPosSale(owner, tenantId, {
      branchId,
      paymentMethod: 'CASH',
      items: [{ productItemId: comboId, quantity }, ...extra],
    });

  async function failureOf(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (error) {
      return error as HttpException;
    }
    throw new Error('expected the call to fail');
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
    products = app.get(ProductService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'pos-combo-e2e' },
    });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        phoneNumber: owner.phoneNumber,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'Chi nhánh combo', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });

    const make = async (
      id: string,
      name: string,
      type: 'PRODUCT' | 'COMBO' | 'SERVICE',
      price: number,
    ) => {
      const productId = randomUUID();
      await prisma.product.create({
        data: { id: productId, tenantId, name, productType: type },
      });
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `PC-${id}`,
          sku: `SKU-${name}-${id.slice(0, 4)}`,
          retailPrice: price,
          costPrice: 100,
          itemType: type,
        },
      });
    };
    await make(tableId, 'Bàn', 'PRODUCT', 2000);
    await make(chairId, 'Ghế', 'PRODUCT', 500);
    await make(installId, 'Lắp đặt', 'SERVICE', 300);
    await make(comboId, 'Bộ phòng ăn', 'COMBO', 3500);
    await prisma.comboComponent.createMany({
      data: [
        { comboItemId: comboId, componentItemId: tableId, quantity: 1 },
        { comboItemId: comboId, componentItemId: chairId, quantity: 4 },
        { comboItemId: comboId, componentItemId: installId, quantity: 1 },
      ],
    });

    await setStock(tableId, 5);
    await setStock(chairId, 7);
  });

  // Dọn xong mới đóng app: AppModule giữ cron, Redis và Socket.IO, không đóng thì jest treo.
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
    await prisma.invoice.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.comboComponent.deleteMany({
      where: { comboItem: { tenantId } },
    });
    await prisma.productItem.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  describe('availability shown by the till search', () => {
    it('is the scarcest component on the shelf: 5 tables, 7 chairs at 4 a set → 1 set', async () => {
      const combo = await comboAsSearched();
      expect(combo.availableStock).toBe(1);
      expect(combo.stock).toBe(1);
    });

    it('counts the shelf, not the stock on hand: packed chairs are not for sale', async () => {
      await prisma.inventory.updateMany({
        where: { tenantId, productItemId: chairId },
        data: { lockedStock: 4 }, // 7 on hand, only 3 on the shelf
      });
      const combo = await comboAsSearched();
      expect(combo.availableStock).toBe(0);
      await prisma.inventory.updateMany({
        where: { tenantId, productItemId: chairId },
        data: { lockedStock: 0 },
      });
    });

    it('reports a plain product by its shelf too', async () => {
      await prisma.inventory.updateMany({
        where: { tenantId, productItemId: tableId },
        data: { lockedStock: 2 },
      });
      const result = await products.search(tenantId, {
        page: 1,
        limit: 20,
        locationId: branchId,
        locationType: 'BRANCH',
      });
      const table = result.data
        .flatMap((product) => product.items)
        .find((row) => row.id === tableId)!;
      expect(table.stock).toBe(5); // on hand
      expect(table.availableStock).toBe(3); // for sale
      await prisma.inventory.updateMany({
        where: { tenantId, productItemId: tableId },
        data: { lockedStock: 0 },
      });
    });
  });

  describe('selling a combo', () => {
    let orderId: string;

    it('deducts the components, never the combo, and invoices the combo line only', async () => {
      const { order } = await sellCombo();
      orderId = order.id;
      expect(order.status).toBe('COMPLETED');
      expect(order.grandTotal).toBe(3500);

      expect(await stockOf(tableId)).toBe(4);
      expect(await stockOf(chairId)).toBe(3);
      // A combo has no stock row, and the sale must not have made one.
      expect(await inventoryOf(comboId)).toBeNull();

      const lines = await prisma.orderItem.findMany({
        where: { orderId },
        orderBy: { lineType: 'asc' },
      });
      expect(lines.map((line) => line.lineType).sort()).toEqual([
        'COMBO',
        'COMBO_COMPONENT',
        'COMBO_COMPONENT',
        'SERVICE',
      ]);
      const parent = lines.find((line) => line.lineType === 'COMBO')!;
      const children = lines.filter((line) => line.parentItemId === parent.id);
      expect(children).toHaveLength(3);
      expect(children.every((line) => Number(line.unitPrice) === 0)).toBe(true);
      expect(
        children.find((line) => line.productItemId === chairId)?.quantity,
      ).toBe(4);

      // Each stocked child owns its own SALE ledger row; the parent and the service own none.
      const sales = await prisma.inventoryTransaction.findMany({
        where: { tenantId, type: 'SALE', referenceId: orderId },
      });
      expect(sales).toHaveLength(2);
      const stockedIds = children
        .filter((line) => line.lineType === 'COMBO_COMPONENT')
        .map((line) => line.id)
        .sort();
      expect(sales.map((row) => row.orderItemId).sort()).toEqual(stockedIds);

      // Hóa đơn chỉ có dòng combo cha.
      const invoice = await prisma.invoice.findFirstOrThrow({
        where: { orderId, type: 'SALE' },
        include: { lines: true },
      });
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.lines).toHaveLength(1);
      expect(Number(invoice.total)).toBe(3500);
    });

    it('puts the components back on a return, and makes no stock for the combo', async () => {
      await orders.updateStatus(owner, tenantId, orderId, 'RETURNED');
      expect(await stockOf(tableId)).toBe(5);
      expect(await stockOf(chairId)).toBe(7);
      expect(await inventoryOf(comboId)).toBeNull();
      expect(
        await prisma.inventoryLot.count({
          where: { tenantId, productItemId: comboId },
        }),
      ).toBe(0);
    });

    it('refuses the whole sale when one component is short, naming it', async () => {
      await setStock(chairId, 3); // a set needs 4
      const orderCount = await prisma.order.count({ where: { tenantId } });

      const error = await failureOf(() => sellCombo());
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(JSON.stringify(error.getResponse())).toContain('Ghế');

      // Rolled back: no order, and the table that was available was not touched.
      expect(await prisma.order.count({ where: { tenantId } })).toBe(
        orderCount,
      );
      expect(await stockOf(tableId)).toBe(5);
      expect(await stockOf(chairId)).toBe(3);
      await setStock(chairId, 7);
    });

    it('books a loose chair and a combo of chairs on separate lines with separate ledger rows', async () => {
      const { order } = await sellCombo(1, [
        { productItemId: chairId, quantity: 1 },
      ]);
      expect(await stockOf(chairId)).toBe(2); // 7 - 4 (combo) - 1 (loose)

      const chairLines = await prisma.orderItem.findMany({
        where: { orderId: order.id, productItemId: chairId },
      });
      expect(chairLines).toHaveLength(2);
      const sales = await prisma.inventoryTransaction.findMany({
        where: {
          tenantId,
          type: 'SALE',
          referenceId: order.id,
          productItemId: chairId,
        },
      });
      // A line may draw from more than one lot (FIFO), so compare what each line took in total.
      const takenBy = new Map<string, number>();
      for (const row of sales) {
        takenBy.set(
          row.orderItemId!,
          (takenBy.get(row.orderItemId!) ?? 0) - row.quantity,
        );
      }
      expect(takenBy.size).toBe(2);
      for (const line of chairLines) {
        expect(takenBy.get(line.id)).toBe(line.quantity);
      }
    });
  });
});
