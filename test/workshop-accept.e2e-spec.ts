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

// Kiểm xưởng xác nhận đang làm YCSX (Postgres thật).
describe('workshop accepts a production request', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let requests: ProductionRequestService;
  let deliveries: ProductionDeliveryService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const workerId = randomUUID();
  const otherWorkerId = randomUUID();
  const branchId = randomUUID();
  const workshopId = randomUUID();
  const otherWorkshopId = randomUUID();
  const productId = randomUUID();
  const cabinetId = randomUUID();
  const customerId = randomUUID();
  const orderId = randomUUID();
  const orderItemId = randomUUID();

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
    phoneNumber: `wa-owner-${ownerId}`,
  };
  const worker: AuthUser = {
    ...baseUser,
    userId: workerId,
    systemRole: SystemRole.STAFF,
    workshopId,
    phoneNumber: `wa-worker-${workerId}`,
  };
  const otherWorker: AuthUser = {
    ...baseUser,
    userId: otherWorkerId,
    systemRole: SystemRole.STAFF,
    workshopId: otherWorkshopId,
    phoneNumber: `wa-other-${otherWorkerId}`,
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

  /** YCSX mới đã gửi xưởng A, một dòng gắn với dòng đơn. */
  async function sentRequest(): Promise<{ id: string; lineId: string }> {
    const created = await requests.create(owner, {
      supplierId: workshopId,
      locationId: branchId,
      items: [{ productItemId: cabinetId, quantity: 2, orderItemId }],
    });
    await requests.updateStatus(owner, created.id, { status: 'SENT' });
    return { id: created.id, lineId: created.items[0].id };
  }

  async function eventTypesOfOrder(): Promise<string[]> {
    const rows = await prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { occurredAt: 'asc' },
      select: { type: true },
    });
    return rows.map((row) => row.type);
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

    await prisma.tenant.create({ data: { id: tenantId, name: 'wa-e2e' } });
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
      data: { id: branchId, tenantId, name: 'Chi nhánh', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
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
      ],
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Tủ', isManufacturable: true },
    });
    await prisma.productItem.create({
      data: {
        id: cabinetId,
        tenantId,
        productId,
        productName: 'Tủ',
        productCode: `WA-${cabinetId}`,
        sku: `WA-${cabinetId}`,
        retailPrice: 5000,
        costPrice: 1000,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách e2e' },
    });
    await prisma.order.create({
      data: {
        id: orderId,
        tenantId,
        code: `DH-${orderId}`,
        status: 'CONFIRMED',
        priority: 'HIGH',
        branchId,
        customerId,
        grandTotal: 10000,
        items: {
          create: {
            id: orderItemId,
            productItemId: cabinetId,
            sourceLocationId: branchId,
            quantity: 2,
            listUnitPrice: 5000,
            unitPrice: 5000,
            lineTotal: 10000,
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
    await prisma.productionDelivery.deleteMany({ where });
    await prisma.productionRequest.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.customer.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.supplier.deleteMany({ where });
    await prisma.productItem.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  }

  it('blocks the shop from cancelling once the workshop accepts; only the workshop can cancel', async () => {
    const { id } = await sentRequest();

    // Xưởng khác không thấy yêu cầu này.
    expect(await codeOf(deliveries.accept(otherWorker, id))).toBe(
      ErrorCode.PRODUCTION_REQUEST_NOT_FOUND,
    );
    expect(
      await codeOf(deliveries.cancelRequest(otherWorker, id, { reason: 'x' })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_NOT_FOUND);

    const accepted = await deliveries.accept(worker, id);
    expect(accepted.acceptedAt).not.toBeNull();
    expect(accepted.acceptedBy?.id).toBe(workerId);
    expect(await codeOf(deliveries.accept(worker, id))).toBe(
      ErrorCode.PRODUCTION_REQUEST_NOT_ACCEPTABLE,
    );

    expect(
      await codeOf(requests.updateStatus(owner, id, { status: 'CANCELLED' })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_IN_PRODUCTION);

    // Chủ shop được báo xưởng đã nhận làm.
    expect(
      await prisma.notification.findFirst({
        where: {
          tenantId,
          recipientId: ownerId,
          type: 'PRODUCTION_WORKSHOP_ACCEPTED',
        },
      }),
    ).not.toBeNull();

    const cancelled = await deliveries.cancelRequest(worker, id, {
      reason: 'Hết gỗ óc chó',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.note).toContain('Xưởng huỷ: Hết gỗ óc chó');
    expect(
      await prisma.notification.findFirst({
        where: {
          tenantId,
          recipientId: ownerId,
          type: 'PRODUCTION_WORKSHOP_CANCELLED',
        },
      }),
    ).not.toBeNull();
    expect(
      await codeOf(deliveries.cancelRequest(worker, id, { reason: 'lần 2' })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);

    expect(await eventTypesOfOrder()).toContain('PRODUCTION_STARTED');
  });

  it('counts the first delivery note as accepting, and refuses a workshop cancel while it is pending', async () => {
    const { id, lineId } = await sentRequest();

    const withNote = await deliveries.create(worker, id, {
      items: [{ productionRequestItemId: lineId, quantity: 1 }],
    });
    expect(withNote.acceptedAt).not.toBeNull();
    expect(
      await codeOf(requests.updateStatus(owner, id, { status: 'CANCELLED' })),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID);
    expect(
      await codeOf(deliveries.cancelRequest(worker, id, { reason: 'x' })),
    ).toBe(ErrorCode.PRODUCTION_DELIVERY_STATUS_INVALID);

    const pending = withNote.deliveries.find((d) => d.status === 'PENDING')!;
    await deliveries.cancelByWorkshop(worker, pending.id, { reason: 'Nhầm' });
    // Phiếu đã rút nhưng xưởng vẫn đang làm: shop vẫn không huỷ được, xưởng thì được.
    expect(
      await codeOf(requests.updateStatus(owner, id, { status: 'CANCELLED' })),
    ).toBe(ErrorCode.PRODUCTION_REQUEST_IN_PRODUCTION);
    const cancelled = await deliveries.cancelRequest(worker, id, {
      reason: 'Dừng',
    });
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('lets exactly one cancel win when the workshop cancels while delivering', async () => {
    const { id, lineId } = await sentRequest();
    await deliveries.accept(worker, id);

    const [cancel, deliver] = await Promise.allSettled([
      deliveries.cancelRequest(worker, id, { reason: 'Dừng' }),
      deliveries.create(worker, id, {
        items: [{ productionRequestItemId: lineId, quantity: 1 }],
      }),
    ]);
    expect(
      (cancel.status === 'fulfilled') !== (deliver.status === 'fulfilled'),
    ).toBe(true);
    if (deliver.status === 'fulfilled') {
      const pending = deliver.value.deliveries.find(
        (d) => d.status === 'PENDING',
      )!;
      await deliveries.cancelByWorkshop(worker, pending.id, { reason: 'Dọn' });
      await deliveries.cancelRequest(worker, id, { reason: 'Dọn' });
    }
  });

  it('lets exactly one side win when the workshop accepts while the shop cancels', async () => {
    const { id } = await sentRequest();

    const [accept, cancel] = await Promise.allSettled([
      deliveries.accept(worker, id),
      requests.updateStatus(owner, id, { status: 'CANCELLED' }),
    ]);
    const acceptWon = accept.status === 'fulfilled';
    const cancelWon = cancel.status === 'fulfilled';
    expect(acceptWon !== cancelWon).toBe(true);

    const row = await prisma.productionRequest.findUniqueOrThrow({
      where: { id },
    });
    if (acceptWon) {
      expect(row.status).toBe('SENT');
      expect(row.acceptedAt).not.toBeNull();
      await deliveries.cancelRequest(worker, id, { reason: 'Dọn' });
    } else {
      expect(row.status).toBe('CANCELLED');
      expect(row.acceptedAt).toBeNull();
    }
  });

  it('lets only one of two workers accept', async () => {
    const secondWorkerId = randomUUID();
    await prisma.user.create({
      data: {
        id: secondWorkerId,
        tenantId,
        phoneNumber: `wa-worker2-${secondWorkerId}`,
        systemRole: SystemRole.STAFF,
        workshopId,
      },
    });
    const secondWorker: AuthUser = {
      ...worker,
      userId: secondWorkerId,
      phoneNumber: `wa-worker2-${secondWorkerId}`,
    };
    const { id } = await sentRequest();

    const results = await Promise.allSettled([
      deliveries.accept(worker, id),
      deliveries.accept(secondWorker, id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
