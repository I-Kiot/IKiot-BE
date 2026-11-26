import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ProductionRequestService } from './../src/modules/production-requests/production-requests.service';
import { ProductionDeliveryService } from './../src/modules/production-requests/production-deliveries.service';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

// Kiểm số thiếu dùng chung giữa YCSX gắn dòng và YCSX chung (Postgres thật).
describe('pooled production shortage and per-line progress', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let requests: ProductionRequestService;
  let deliveries: ProductionDeliveryService;
  let list: ProductionListService;
  let reads: OrderReadService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const txId = randomUUID();
  const workshopId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const sofaA = randomUUID();
  const sofaB = randomUUID();
  const sofaC = randomUUID();

  const owner: AuthUser = {
    tenantId,
    roleId: null,
    permissions: new Set<string>(),
    shiftSupervision: null,
    email: null,
    userId: ownerId,
    systemRole: SystemRole.TENANT_OWNER,
    branchId: null,
    warehouseId: null,
    displayName: 'Owner',
    phoneNumber: `pool-owner-${ownerId}`,
  };

  async function bodyOf(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return (
        error as { getResponse: () => Record<string, unknown> }
      ).getResponse();
    }
    throw new Error('expected the call to be refused');
  }

  /** Đơn tay đã xác nhận tại Showroom TX (tồn 0) với một dòng. */
  async function makeOrder(
    productItemId: string,
    quantity: number,
    priority = 'NORMAL',
  ) {
    const id = randomUUID();
    const itemId = randomUUID();
    await prisma.order.create({
      data: {
        id,
        tenantId,
        code: `DH-${id}`,
        status: 'CONFIRMED',
        priority,
        branchId: txId,
        customerId,
        assigneeId: ownerId,
        grandTotal: 1000 * quantity,
        items: {
          create: {
            id: itemId,
            productItemId,
            sourceLocationId: txId,
            quantity,
            listUnitPrice: 1000,
            unitPrice: 1000,
            lineTotal: 1000 * quantity,
          },
        },
      },
    });
    return { orderId: id, itemId };
  }

  const draftFor = (
    productItemId: string,
    lines: { quantity: number; orderItemId?: string }[],
  ) =>
    requests.create(owner, {
      supplierId: workshopId,
      locationId: txId,
      items: lines.map((line) => ({ productItemId, ...line })),
    });

  const send = (id: string) =>
    requests.updateStatus(owner, id, { status: 'SENT' });

  const production = async (orderId: string, itemId: string) => {
    const detail = await reads.findOne(owner, tenantId, orderId);
    return detail.items.find((item) => item.id === itemId)!.production;
  };

  const poolRow = async (productItemId: string) => {
    const page = await list.list(owner, {
      page: 1,
      limit: 100,
      locationId: txId,
      productItemId,
    });
    return page.data.find((row) => row.productItemId === productItemId);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    requests = app.get(ProductionRequestService);
    deliveries = app.get(ProductionDeliveryService);
    list = app.get(ProductionListService);
    reads = app.get(OrderReadService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'pool-e2e' } });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: owner.phoneNumber,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.location.create({
      data: {
        id: txId,
        tenantId,
        name: 'Showroom Thanh Xuân',
        type: 'BRANCH',
      },
    });
    await prisma.branch.create({
      data: { id: txId, tenantId, locationId: txId },
    });
    await prisma.supplier.create({
      data: {
        id: workshopId,
        tenantId,
        supplierName: 'Xưởng mộc',
        type: 'WORKSHOP',
      },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Sofa', isManufacturable: true },
    });
    await prisma.productItem.createMany({
      data: [sofaA, sofaB, sofaC].map((id, index) => ({
        id,
        tenantId,
        productId,
        productName: `Sofa ${'ABC'[index]}`,
        productCode: `POOL-${id}`,
        sku: `POOL-${id}`,
        retailPrice: 1000,
        costPrice: 500,
      })),
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách e2e' },
    });
  });

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
    await prisma.inventoryTransaction.deleteMany({ where });
    await prisma.inventoryLot.deleteMany({ where });
    await prisma.productionDelivery.deleteMany({ where });
    await prisma.stockMovementRequest.deleteMany({ where });
    await prisma.productionRequest.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.productItemSupplier.deleteMany({
      where: { supplierId: workshopId },
    });
    await prisma.supplier.deleteMany({ where });
    await prisma.productItem.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  it('A1: an unlinked draft already covers the pooled shortage, so the line cannot order more', async () => {
    const { orderId, itemId } = await makeOrder(sofaA, 1);
    await draftFor(sofaA, [{ quantity: 1 }]);

    const line = await production(orderId, itemId);
    expect(line).toMatchObject({
      orderableQuantity: 0,
      coveringRequests: [{ code: expect.stringMatching(/^YCSX\d{6}$/) }],
    });

    const refused = await bodyOf(
      draftFor(sofaA, [{ quantity: 1, orderItemId: itemId }]),
    );
    expect(refused).toMatchObject({
      code: ErrorCode.PRODUCTION_EXCEEDS_ORDER_SHORTAGE,
      scope: 'LINE',
      orderable: 0,
    });

    expect(await poolRow(sofaA)).toMatchObject({
      demandQuantity: 1,
      draftQuantity: 1,
      shortQuantity: 0,
    });
  });

  it('A2: a linked SENT request already in the data consumes the line and leaves a visible surplus', async () => {
    const { orderId, itemId } = await makeOrder(sofaA, 1);
    // Dữ liệu xấu có sẵn: YCSX gắn dòng được tạo trước khi guard biết số thiếu chung.
    const code = `YCSX-E2E-${randomUUID().slice(0, 6)}`;
    await prisma.productionRequest.create({
      data: {
        tenantId,
        code,
        supplierId: workshopId,
        locationId: txId,
        status: 'SENT',
        sentAt: new Date(),
        items: {
          create: { productItemId: sofaA, orderItemId: itemId, quantity: 1 },
        },
      },
    });

    const row = await poolRow(sofaA);
    // Dòng thứ nhất (A1) vẫn còn, dòng này bị YCSX gắn riêng nhận hết nên không có trong `orders`.
    expect(row?.orders.map((order) => order.orderItemId)).not.toContain(itemId);
    expect(row?.draftQuantity).toBe(1);

    const line = await production(orderId, itemId);
    expect(line.orderableQuantity).toBe(0);
    expect(line.progress).toMatchObject([
      {
        status: 'SENT',
        quantity: 1,
        receivedQuantity: 0,
        deliveringQuantity: 0,
      },
    ]);
  });

  it('B: two orders share one pooled shortage; a request over it is refused with scope POOL', async () => {
    const o1 = await makeOrder(sofaB, 2, 'HIGH');
    const o2 = await makeOrder(sofaB, 1);
    await draftFor(sofaB, [{ quantity: 1 }]); // đặt chung
    const y3 = await draftFor(sofaB, [{ quantity: 1, orderItemId: o1.itemId }]);
    await send(y3.id);

    expect(await poolRow(sofaB)).toMatchObject({
      demandQuantity: 2,
      onOrderQuantity: 0,
      draftQuantity: 1,
      shortQuantity: 1,
    });
    expect((await production(o1.orderId, o1.itemId)).orderableQuantity).toBe(1);
    expect((await production(o2.orderId, o2.itemId)).orderableQuantity).toBe(1);

    const refused = await bodyOf(
      draftFor(sofaB, [
        { quantity: 1, orderItemId: o1.itemId },
        { quantity: 1, orderItemId: o2.itemId },
      ]),
    );
    expect(refused).toMatchObject({
      code: ErrorCode.PRODUCTION_EXCEEDS_ORDER_SHORTAGE,
      scope: 'POOL',
      requested: 2,
      orderable: 1,
    });

    await draftFor(sofaB, [{ quantity: 1, orderItemId: o1.itemId }]);
    expect(await poolRow(sofaB)).toMatchObject({
      demandQuantity: 1,
      draftQuantity: 1,
      shortQuantity: 0,
    });
    expect((await production(o2.orderId, o2.itemId)).orderableQuantity).toBe(0);
    const first = await production(o1.orderId, o1.itemId);
    expect(first.orderableQuantity).toBe(0);
    expect(first.requests).toHaveLength(2);
  });

  it('shows per-line progress: accepted, delivering, partly received, completed', async () => {
    const { orderId, itemId } = await makeOrder(sofaC, 3);
    const created = await draftFor(sofaC, [
      { quantity: 3, orderItemId: itemId },
    ]);
    await send(created.id);
    const lineId = created.items[0].id;

    let line = await production(orderId, itemId);
    expect(line.progress).toMatchObject([
      { status: 'SENT', quantity: 3, receivedQuantity: 0, acceptedAt: null },
    ]);

    await prisma.productionRequest.update({
      where: { id: created.id },
      data: { acceptedAt: new Date(), acceptedById: ownerId },
    });
    line = await production(orderId, itemId);
    expect(line.progress[0].acceptedAt).not.toBeNull();

    const delivery = await prisma.productionDelivery.create({
      data: {
        tenantId,
        code: `PGX-E2E-${randomUUID().slice(0, 6)}`,
        productionRequestId: created.id,
        createdById: ownerId,
        status: 'PENDING',
        items: { create: { productionRequestItemId: lineId, quantity: 1 } },
      },
    });
    line = await production(orderId, itemId);
    expect(line.progress[0].deliveringQuantity).toBe(1);

    await deliveries.receive(owner, delivery.id, {
      items: [{ productionRequestItemId: lineId, receivedQuantity: 1 }],
    });
    line = await production(orderId, itemId);
    expect(line.progress[0]).toMatchObject({
      status: 'PARTIALLY_RECEIVED',
      receivedQuantity: 1,
      deliveringQuantity: 0,
    });

    await requests.receive(owner, created.id, {
      items: [{ productionRequestItemId: lineId, receivedQuantity: 2 }],
    });
    line = await production(orderId, itemId);
    expect(line.progress[0]).toMatchObject({
      status: 'COMPLETED',
      receivedQuantity: 3,
      closedShort: false,
    });
    expect(line.requests).toEqual([]);
    expect(line.openQuantity).toBe(0);
  });

  it('the order list returns the same orderable quantity and progress as the detail', async () => {
    const { orderId, itemId } = await makeOrder(sofaB, 1);
    const detail = await production(orderId, itemId);
    const page = await reads.findAll(owner, tenantId, {
      page: 1,
      limit: 50,
      excludePos: true,
    });
    const row = page.data.find((order) => order.id === orderId)!;
    const fromList = row.items.find((item) => item.id === itemId)!.production;
    expect(fromList.orderableQuantity).toBe(detail.orderableQuantity);
    expect(fromList.progress).toEqual(detail.progress);
    expect(fromList.coveringRequests).toEqual(detail.coveringRequests);
  });
});
