import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ProductionRequestService } from './../src/modules/production-requests/production-requests.service';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { SupplierService } from './../src/modules/suppliers/suppliers.service';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

// Hành trình GĐ1 – Bước 4 against real Postgres (docker compose up -d): an order short of a
// cabinet shows on the production list, a production request covers it, and receiving the
// workshop's goods is the moment stock rises - lots, ledger, defects and the workshop's debt
// checked by reading the tables back. Creates its own tenant and removes it afterwards.
describe('production list, production requests and workshop receipts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let requests: ProductionRequestService;
  let list: ProductionListService;
  let movements: StockMovementService;
  let suppliers: SupplierService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const damagedId = randomUUID();
  const workshopId = randomUUID();
  const goodsSupplierId = randomUUID();
  const customerId = randomUUID();
  const productId = randomUUID();
  const cabinetId = randomUUID();
  const comboId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();

  const baseUser = {
    tenantId,
    roleId: null,
    permissions: new Set<string>(),
    shiftSupervision: null,
    email: null,
  };
  const owner: AuthUser = {
    ...baseUser,
    userId: ownerId,
    systemRole: SystemRole.TENANT_OWNER,
    branchId: null,
    warehouseId: null,
    displayName: 'Owner',
    phoneNumber: `prod-owner-${ownerId}`,
  };
  // Posted at the warehouse - the branch is somebody else's.
  const warehouseStaff: AuthUser = {
    ...baseUser,
    userId: staffId,
    systemRole: SystemRole.STAFF,
    branchId: null,
    warehouseId,
    displayName: 'Kho',
    phoneNumber: `prod-staff-${staffId}`,
  };

  async function codeOf(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      const response = (
        error as { getResponse?: () => unknown }
      ).getResponse?.();
      return (response as { code?: string })?.code ?? String(error);
    }
    throw new Error('expected the call to be refused');
  }

  async function stockAt(locationId: string) {
    const row = await prisma.inventory.findFirst({
      where: { tenantId, locationId, productItemId: cabinetId },
    });
    const lots = await prisma.inventoryLot.aggregate({
      where: { tenantId, locationId, productItemId: cabinetId },
      _sum: { remainingQuantity: true },
    });
    expect(lots._sum.remainingQuantity ?? 0).toBe(row?.stock ?? 0);
    return row?.stock ?? 0;
  }

  const listRows = async (
    user: AuthUser,
    query: { locationId?: string; onlyShort?: boolean } = {},
  ) => (await list.list(user, { page: 1, limit: 100, ...query })).data;

  async function cabinetRow() {
    const rows = await listRows(owner);
    return rows.find(
      (row) => row.productItemId === cabinetId && row.location?.id === branchId,
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    requests = app.get(ProductionRequestService);
    list = app.get(ProductionListService);
    movements = app.get(StockMovementService);
    suppliers = app.get(SupplierService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'prod-e2e' } });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: owner.phoneNumber,
          systemRole: SystemRole.TENANT_OWNER,
        },
        {
          id: staffId,
          tenantId,
          phoneNumber: warehouseStaff.phoneNumber,
          systemRole: SystemRole.STAFF,
        },
      ],
    });
    await prisma.location.create({
      data: {
        id: damagedId,
        tenantId,
        name: 'Kho hỏng',
        type: 'WAREHOUSE',
        isSellable: false,
      },
    });
    await prisma.location.create({
      data: {
        id: branchId,
        tenantId,
        name: 'Chi nhánh',
        type: 'BRANCH',
        damagedLocationId: damagedId,
      },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho tổng', type: 'WAREHOUSE' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.warehouse.createMany({
      data: [
        { id: warehouseId, tenantId, locationId: warehouseId },
        { id: damagedId, tenantId, locationId: damagedId },
      ],
    });
    await prisma.supplier.createMany({
      data: [
        {
          id: workshopId,
          tenantId,
          supplierName: 'Xưởng mộc',
          type: 'WORKSHOP',
        },
        { id: goodsSupplierId, tenantId, supplierName: 'NCC thường' },
      ],
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Tủ' },
    });
    await prisma.productItem.createMany({
      data: [
        {
          id: cabinetId,
          tenantId,
          productId,
          productName: 'Tủ',
          productCode: `PR-${cabinetId}`,
          sku: `PR-${cabinetId}`,
          retailPrice: 5000,
          costPrice: 1000,
        },
        {
          id: comboId,
          tenantId,
          productId,
          productName: 'Combo góc làm việc',
          productCode: `PRC-${comboId}`,
          sku: `PRC-${comboId}`,
          retailPrice: 9000,
          costPrice: 0,
          itemType: 'COMBO',
        },
      ],
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách e2e' },
    });
    // A manual order confirmed at the branch, stock 0 - the hành trình example.
    await prisma.order.create({
      data: {
        id: orderId,
        tenantId,
        code: `DH-${orderId}`,
        status: 'CONFIRMED',
        priority: 'HIGH',
        branchId,
        customerId,
        assigneeId: staffId,
        grandTotal: 10000,
        items: {
          create: {
            id: orderItemId,
            productItemId: cabinetId,
            sourceLocationId: branchId,
            quantity: 3,
            listUnitPrice: 5000,
            unitPrice: 5000,
            lineTotal: 15000,
          },
        },
      },
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
    await prisma.stockMovementRequest.deleteMany({ where });
    await prisma.productionRequest.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.productItemSupplier.deleteMany({
      where: { supplierId: { in: [workshopId, goodsSupplierId] } },
    });
    await prisma.supplier.deleteMany({ where });
    await prisma.productItem.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.location.updateMany({
      where,
      data: { damagedLocationId: null },
    });
    await prisma.location.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  let requestId: string;
  let lineId: string;

  it('lists the confirmed order as short, grouped under the cabinet at its branch', async () => {
    const row = await cabinetRow();
    expect(row).toMatchObject({
      stock: 0,
      demandQuantity: 3,
      onOrderQuantity: 0,
      draftQuantity: 0,
      shortQuantity: 3,
    });
    expect(row?.orders).toEqual([
      expect.objectContaining({ orderItemId, quantity: 3, priority: 'HIGH' }),
    ]);
    expect(row?.orders[0].assignee?.id).toBe(staffId);
  });

  it('answers 404 for a location that is not the shop’s, instead of an empty list', async () => {
    expect(await codeOf(listRows(owner, { locationId: randomUUID() }))).toBe(
      ErrorCode.LOCATION_NOT_FOUND,
    );
    expect(
      await codeOf(
        requests.findAll(owner, {
          page: 1,
          limit: 20,
          locationId: randomUUID(),
        }),
      ),
    ).toBe(ErrorCode.LOCATION_NOT_FOUND);
  });

  it('lists every producible SKU at every sellable location, short or not', async () => {
    const rows = await listRows(owner);
    // The cabinet at the warehouse has no order and no stock, and still shows - anything can be ordered.
    expect(
      rows.find(
        (row) =>
          row.productItemId === cabinetId && row.location?.id === warehouseId,
      ),
    ).toMatchObject({ demandQuantity: 0, shortQuantity: 0 });
    // A combo is ordered through its components, and the damaged-goods location never takes deliveries.
    expect(rows.some((row) => row.productItemId === comboId)).toBe(false);
    expect(rows.some((row) => row.location?.id === damagedId)).toBe(false);
    // Short rows first.
    expect(rows[0]).toMatchObject({
      productItemId: cabinetId,
      shortQuantity: 3,
    });

    const page = await list.list(owner, {
      page: 1,
      limit: 100,
      onlyShort: true,
    });
    expect(page.data).toHaveLength(1);
    expect(page.summary.shortRows).toBe(1);
  });

  it('keeps another location out of a staff account’s list', async () => {
    expect(
      await codeOf(listRows(warehouseStaff, { locationId: branchId })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED);
    const own = await listRows(warehouseStaff);
    expect(own.every((row) => row.location?.id === warehouseId)).toBe(true);
  });

  it('refuses a goods supplier, a damaged-goods location and a combo', async () => {
    const line = { productItemId: cabinetId, quantity: 1 };
    expect(
      await codeOf(
        requests.create(owner, {
          supplierId: goodsSupplierId,
          locationId: branchId,
          items: [line],
        }),
      ),
    ).toBe(ErrorCode.SUPPLIER_NOT_WORKSHOP);
    expect(
      await codeOf(
        requests.create(owner, {
          supplierId: workshopId,
          locationId: damagedId,
          items: [line],
        }),
      ),
    ).toBe(ErrorCode.LOCATION_NOT_SELLABLE);
    expect(
      await codeOf(
        requests.create(owner, {
          supplierId: workshopId,
          locationId: branchId,
          items: [{ productItemId: comboId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_ITEM_NOT_PRODUCIBLE);
  });

  it('refuses a workshop on a plain supplier import', async () => {
    expect(
      await codeOf(
        movements.create(owner, {
          movementType: 'IMPORT',
          fromSupplierId: workshopId,
          toLocationId: branchId,
          details: [{ productItemId: cabinetId, quantity: 1, importPrice: 10 }],
        }),
      ),
    ).toBe(ErrorCode.IMPORT_WORKSHOP_VIA_PRODUCTION_REQUEST);
  });

  it('creates a DRAFT with the next YCSX code, counted as drafted on the list', async () => {
    const created = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      expectedReadyDate: '2026-10-20',
      items: [{ productItemId: cabinetId, quantity: 2, orderItemId }],
    });
    requestId = created.id;
    lineId = created.items[0].id;
    expect(created.status).toBe('DRAFT');
    expect(created.code).toMatch(/^YCSX\d{6}$/);
    expect(created.items[0].orderItem?.id).toBe(orderItemId);

    // "Thêm vào yêu cầu" for the same line adds to it rather than duplicating it.
    const added = await requests.addItem(owner, requestId, {
      productItemId: cabinetId,
      quantity: 1,
      orderItemId,
    });
    expect(added.items).toHaveLength(1);
    expect(added.items[0].quantity).toBe(3);

    expect(await cabinetRow()).toMatchObject({
      draftQuantity: 3,
      shortQuantity: 0,
    });
  });

  it('refuses to receive before the request is sent, then counts it as on order', async () => {
    expect(
      await codeOf(
        requests.receive(owner, requestId, {
          items: [{ productionRequestItemId: lineId, receivedQuantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);

    const sent = await requests.updateStatus(owner, requestId, {
      status: 'SENT',
    });
    expect(sent.status).toBe('SENT');
    expect(sent.sentAt).not.toBeNull();
    expect(
      await codeOf(requests.update(owner, requestId, { note: 'quá muộn' })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_LOCKED);

    expect(await cabinetRow()).toMatchObject({
      onOrderQuantity: 3,
      draftQuantity: 0,
      shortQuantity: 0,
    });
  });

  it('keeps the warehouse staff from receiving goods delivered to the branch', async () => {
    expect(
      await codeOf(
        requests.receive(warehouseStaff, requestId, {
          items: [{ productionRequestItemId: lineId, receivedQuantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_LOCATION_DENIED);
  });

  it('receives 2 (1 defective): stock +1 at the branch, +1 at the damaged location, one WORKSHOP import, debt for the good one', async () => {
    const received = await requests.receive(owner, requestId, {
      items: [
        {
          productionRequestItemId: lineId,
          receivedQuantity: 2,
          defectQuantity: 1,
          unitCost: 1200,
        },
      ],
    });
    expect(received.status).toBe('PARTIALLY_RECEIVED');
    expect(received.items[0].receivedQuantity).toBe(2);
    expect(received.receipts).toHaveLength(1);

    expect(await stockAt(branchId)).toBe(1);
    expect(await stockAt(damagedId)).toBe(1);

    const movement = await prisma.stockMovementRequest.findUniqueOrThrow({
      where: { id: received.stockMovementId },
      include: { details: true },
    });
    expect(movement).toMatchObject({
      movementType: 'IMPORT',
      importSource: 'WORKSHOP',
      status: 'RECEIVED',
      fromSupplierId: workshopId,
      toLocationId: branchId,
      receivedById: ownerId,
    });
    expect(movement.details[0]).toMatchObject({
      productionRequestItemId: lineId,
      receivedQuantity: 2,
      defectQuantity: 1,
      defectLocationId: damagedId,
    });

    const lots = await prisma.inventoryLot.findMany({
      where: { tenantId, productItemId: cabinetId },
      include: { transactions: true },
    });
    expect(lots).toHaveLength(2);
    for (const lot of lots) {
      expect(lot).toMatchObject({
        sourceType: 'WORKSHOP',
        supplierId: workshopId,
        productionRequestItemId: lineId,
        // A standard order line does not reserve the lot.
        orderItemId: null,
      });
      expect(Number(lot.unitCost)).toBe(1200);
    }
    expect(
      lots.flatMap((lot) => lot.transactions.map((tx) => tx.type)).sort(),
    ).toEqual(['DEFECT', 'IMPORT']);

    const workshop = await prisma.supplier.findUniqueOrThrow({
      where: { id: workshopId },
    });
    expect(Number(workshop.outstandingDebt)).toBe(1200);

    // Stock 1 + still on order 1 against demand 3: one short again, nothing drafted.
    expect(await cabinetRow()).toMatchObject({
      stock: 1,
      onOrderQuantity: 1,
      shortQuantity: 1,
    });
  });

  it('refuses to receive more than was ordered, and to cancel after a receipt', async () => {
    expect(
      await codeOf(
        requests.receive(owner, requestId, {
          items: [{ productionRequestItemId: lineId, receivedQuantity: 2 }],
        }),
      ),
    ).toBe(ErrorCode.IMPORT_PRODUCTION_QTY_EXCEEDS);
    expect(
      await codeOf(
        requests.updateStatus(owner, requestId, { status: 'CANCELLED' }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS);
  });

  it('completes on the last piece and locks the workshop type', async () => {
    const done = await requests.receive(owner, requestId, {
      items: [{ productionRequestItemId: lineId, receivedQuantity: 1 }],
    });
    expect(done.status).toBe('COMPLETED');
    expect(done.closedShort).toBe(false);
    expect(done.receipts).toHaveLength(2);
    expect(await stockAt(branchId)).toBe(2);
    // Costed at the SKU's cost price when no workshop price is given.
    expect(
      Number(
        (await prisma.supplier.findUniqueOrThrow({ where: { id: workshopId } }))
          .outstandingDebt,
      ),
    ).toBe(2200);

    expect(
      await codeOf(suppliers.update(tenantId, workshopId, { type: 'GOODS' })),
    ).toBe(ErrorCode.SUPPLIER_TYPE_LOCKED);
  });

  it('closes a partly delivered request short: the rest stops counting as on order', async () => {
    const created = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      items: [{ productItemId: cabinetId, quantity: 3 }],
    });
    await requests.updateStatus(owner, created.id, { status: 'SENT' });
    // Nothing received yet: that is a cancellation, not a short close.
    expect(
      await codeOf(
        requests.updateStatus(owner, created.id, {
          status: 'COMPLETED',
          note: 'thử',
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);

    await requests.receive(owner, created.id, {
      items: [
        { productionRequestItemId: created.items[0].id, receivedQuantity: 1 },
      ],
    });
    expect((await cabinetRow())?.onOrderQuantity).toBe(2);

    expect(
      await codeOf(
        requests.updateStatus(owner, created.id, { status: 'COMPLETED' }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_CLOSE_REASON_REQUIRED);

    const closed = await requests.updateStatus(owner, created.id, {
      status: 'COMPLETED',
      note: 'Xưởng ngừng làm mẫu này',
    });
    expect(closed).toMatchObject({ status: 'COMPLETED', closedShort: true });
    expect(closed.note).toContain('Đóng thiếu: Xưởng ngừng làm mẫu này');
    expect(closed.items[0]).toMatchObject({ quantity: 3, receivedQuantity: 1 });
    expect((await cabinetRow())?.onOrderQuantity).toBe(0);

    // The receipt it already had stays; nothing more can arrive against it.
    expect(closed.receipts).toHaveLength(1);
    expect(
      await codeOf(
        requests.receive(owner, created.id, {
          items: [
            {
              productionRequestItemId: created.items[0].id,
              receivedQuantity: 1,
            },
          ],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);
  });

  it('deletes only a DRAFT', async () => {
    expect(await codeOf(requests.remove(owner, requestId))).toBe(
      ErrorCode.PRODUCTION_REQUEST_LOCKED,
    );
    const draft = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      items: [{ productItemId: cabinetId, quantity: 1 }],
    });
    expect(draft.code).not.toBe(
      (await requests.findOne(owner, requestId)).code,
    );
    await requests.remove(owner, draft.id);
    expect(
      await prisma.productionRequest.count({ where: { id: draft.id } }),
    ).toBe(0);
  });
});
