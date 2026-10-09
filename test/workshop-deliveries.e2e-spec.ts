import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ProductionRequestService } from './../src/modules/production-requests/production-requests.service';
import { ProductionDeliveryService } from './../src/modules/production-requests/production-deliveries.service';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

// Workshop staff and their delivery notes (2026-10-09) against real Postgres: a workshop sees only
// the requests sent to it, announces a short delivery, and nothing is stock until the receiving
// location counts the goods and confirms - lots, debt and the request's status read back.
// Creates its own tenant and removes it afterwards.
describe('workshop staff delivery notes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let requests: ProductionRequestService;
  let deliveries: ProductionDeliveryService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchStaffId = randomUUID();
  const workerId = randomUUID();
  const otherWorkerId = randomUUID();
  const unlinkedId = randomUUID();
  const branchId = randomUUID();
  const damagedId = randomUUID();
  const workshopId = randomUUID();
  const otherWorkshopId = randomUUID();
  const productId = randomUUID();
  const cabinetId = randomUUID();

  const baseUser = {
    tenantId,
    roleId: null,
    permissions: new Set<string>(),
    shiftSupervision: null,
    email: null,
    displayName: null,
    branchId: null,
    warehouseId: null,
  };
  const owner: AuthUser = {
    ...baseUser,
    userId: ownerId,
    systemRole: SystemRole.TENANT_OWNER,
    phoneNumber: `wd-owner-${ownerId}`,
  };
  const branchStaff: AuthUser = {
    ...baseUser,
    userId: branchStaffId,
    systemRole: SystemRole.STAFF,
    branchId,
    phoneNumber: `wd-branch-${branchStaffId}`,
  };
  const worker: AuthUser = {
    ...baseUser,
    userId: workerId,
    systemRole: SystemRole.STAFF,
    workshopId,
    phoneNumber: `wd-worker-${workerId}`,
  };
  const otherWorker: AuthUser = {
    ...baseUser,
    userId: otherWorkerId,
    systemRole: SystemRole.STAFF,
    workshopId: otherWorkshopId,
    phoneNumber: `wd-other-${otherWorkerId}`,
  };
  const unlinked: AuthUser = {
    ...baseUser,
    userId: unlinkedId,
    systemRole: SystemRole.STAFF,
    phoneNumber: `wd-unlinked-${unlinkedId}`,
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
    return row?.stock ?? 0;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    requests = app.get(ProductionRequestService);
    deliveries = app.get(ProductionDeliveryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'wd-e2e' } });
    await prisma.supplier.createMany({
      data: [
        { id: workshopId, tenantId, supplierName: 'Xưởng A', type: 'WORKSHOP' },
        {
          id: otherWorkshopId,
          tenantId,
          supplierName: 'Xưởng B',
          type: 'WORKSHOP',
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
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.warehouse.create({
      data: { id: damagedId, tenantId, locationId: damagedId },
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: owner.phoneNumber,
          systemRole: SystemRole.TENANT_OWNER,
        },
        {
          id: branchStaffId,
          tenantId,
          phoneNumber: branchStaff.phoneNumber,
          systemRole: SystemRole.STAFF,
          locationId: branchId,
        },
        {
          id: workerId,
          tenantId,
          phoneNumber: worker.phoneNumber,
          systemRole: SystemRole.STAFF,
          workshopId,
        },
        {
          id: otherWorkerId,
          tenantId,
          phoneNumber: otherWorker.phoneNumber,
          systemRole: SystemRole.STAFF,
          workshopId: otherWorkshopId,
        },
        {
          id: unlinkedId,
          tenantId,
          phoneNumber: unlinked.phoneNumber,
          systemRole: SystemRole.STAFF,
        },
      ],
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Tủ' },
    });
    await prisma.productItem.create({
      data: {
        id: cabinetId,
        tenantId,
        productId,
        productName: 'Tủ',
        productCode: `WD-${cabinetId}`,
        sku: `WD-${cabinetId}`,
        retailPrice: 5000,
        costPrice: 1000,
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
    await prisma.productionDelivery.deleteMany({ where });
    await prisma.inventoryTransaction.deleteMany({ where });
    await prisma.inventoryLot.deleteMany({ where });
    await prisma.stockMovementRequest.deleteMany({ where });
    await prisma.productionRequest.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.user.deleteMany({ where });
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
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  let requestId: string;
  let lineId: string;
  let draftId: string;

  it('shows a workshop only what was sent to it', async () => {
    const sent = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      items: [{ productItemId: cabinetId, quantity: 5 }],
    });
    requestId = sent.id;
    lineId = sent.items[0].id;
    await requests.updateStatus(owner, requestId, { status: 'SENT' });
    const draft = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      items: [{ productItemId: cabinetId, quantity: 1 }],
    });
    draftId = draft.id;

    const mine = await deliveries.listForWorkshop(worker, {
      page: 1,
      limit: 20,
    });
    expect(mine.data.map((r) => r.id)).toEqual([requestId]);

    const theirs = await deliveries.listForWorkshop(otherWorker, {
      page: 1,
      limit: 20,
    });
    expect(theirs.data).toHaveLength(0);
    expect(
      await codeOf(deliveries.findOneForWorkshop(otherWorker, requestId)),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_NOT_FOUND);
    expect(await codeOf(deliveries.findOneForWorkshop(worker, draftId))).toBe(
      ErrorCode.PRODUCTION_REQUEST_NOT_FOUND,
    );
    expect(
      await codeOf(
        deliveries.listForWorkshop(unlinked, { page: 1, limit: 20 }),
      ),
    ).toBe(ErrorCode.WORKSHOP_STAFF_NOT_LINKED);
  });

  let firstDeliveryId: string;

  it('announces a short delivery without touching stock', async () => {
    const after = await deliveries.create(worker, requestId, {
      items: [{ productionRequestItemId: lineId, quantity: 3 }],
    });
    expect(after.items[0]).toMatchObject({
      quantity: 5,
      receivedQuantity: 0,
      pendingDeliveryQuantity: 3,
    });
    expect(after.deliveries).toHaveLength(1);
    expect(after.deliveries[0]).toMatchObject({ status: 'PENDING' });
    expect(after.deliveries[0].code).toMatch(/^PGX\d{6}$/);
    firstDeliveryId = after.deliveries[0].id;
    expect(await stockAt(branchId)).toBe(0);

    // 5 ordered, 3 already announced: only 2 more fit.
    expect(
      await codeOf(
        deliveries.create(worker, requestId, {
          items: [{ productionRequestItemId: lineId, quantity: 3 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_QTY_EXCEEDS);

    // Goods may be at the door: the request cannot be cancelled under it.
    expect(
      await codeOf(
        requests.updateStatus(owner, requestId, { status: 'CANCELLED' }),
      ),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID);
  });

  it('raises stock only when the location confirms what it counted', async () => {
    const pending = await deliveries.list(branchStaff, {
      page: 1,
      limit: 20,
      status: 'PENDING',
    });
    expect(pending.data.map((d) => d.id)).toEqual([firstDeliveryId]);

    expect(
      await codeOf(
        deliveries.receive(branchStaff, firstDeliveryId, {
          items: [{ productionRequestItemId: lineId, receivedQuantity: 4 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_RECEIVE_EXCEEDS);

    const received = await deliveries.receive(branchStaff, firstDeliveryId, {
      items: [
        {
          productionRequestItemId: lineId,
          receivedQuantity: 3,
          defectQuantity: 1,
        },
      ],
    });
    expect(received).toMatchObject({ status: 'PARTIALLY_RECEIVED' });
    expect(received.items[0]).toMatchObject({
      receivedQuantity: 3,
      pendingDeliveryQuantity: 0,
    });
    expect(await stockAt(branchId)).toBe(2);
    expect(await stockAt(damagedId)).toBe(1);

    const note = await prisma.productionDelivery.findUniqueOrThrow({
      where: { id: firstDeliveryId },
      include: { items: true },
    });
    expect(note).toMatchObject({
      status: 'RECEIVED',
      receivedById: branchStaffId,
      stockMovementId: received.stockMovementId,
    });
    expect(note.items[0]).toMatchObject({
      quantity: 3,
      receivedQuantity: 3,
      defectQuantity: 1,
    });
    // The workshop is owed for the 2 that passed, at the SKU's cost.
    const workshop = await prisma.supplier.findUniqueOrThrow({
      where: { id: workshopId },
    });
    expect(Number(workshop.outstandingDebt)).toBe(2000);

    expect(
      await codeOf(
        deliveries.receive(branchStaff, firstDeliveryId, {
          items: [{ productionRequestItemId: lineId, receivedQuantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID);
  });

  it('lets either side cancel a pending note, and only its own side', async () => {
    const withSecond = await deliveries.create(worker, requestId, {
      items: [{ productionRequestItemId: lineId, quantity: 2 }],
    });
    const second = withSecond.deliveries.find((d) => d.status === 'PENDING')!;

    expect(
      await codeOf(
        deliveries.cancelByWorkshop(otherWorker, second.id, { reason: 'x' }),
      ),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_NOT_FOUND);

    const refused = await deliveries.cancelByLocation(branchStaff, second.id, {
      reason: 'Sai màu',
    });
    expect(refused).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Sai màu',
    });
    expect(await stockAt(branchId)).toBe(2);

    // The room it held is free again.
    const withThird = await deliveries.create(worker, requestId, {
      items: [{ productionRequestItemId: lineId, quantity: 2 }],
    });
    const third = withThird.deliveries.find((d) => d.status === 'PENDING')!;
    const withdrawn = await deliveries.cancelByWorkshop(worker, third.id, {
      reason: 'Giao nhầm phiếu',
    });
    expect(withdrawn.status).toBe('CANCELLED');
  });

  it('completes the request when the last pieces are confirmed', async () => {
    const withLast = await deliveries.create(worker, requestId, {
      items: [{ productionRequestItemId: lineId, quantity: 2 }],
    });
    const last = withLast.deliveries.find((d) => d.status === 'PENDING')!;
    const done = await deliveries.receive(owner, last.id, {
      items: [{ productionRequestItemId: lineId, receivedQuantity: 2 }],
    });
    expect(done).toMatchObject({ status: 'COMPLETED' });
    expect(done.items[0]).toMatchObject({ quantity: 5, receivedQuantity: 5 });
    expect(await stockAt(branchId)).toBe(4);

    expect(
      await codeOf(
        deliveries.create(worker, requestId, {
          items: [{ productionRequestItemId: lineId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);
  });
});
