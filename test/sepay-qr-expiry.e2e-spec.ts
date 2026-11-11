import 'dotenv/config';
import { randomUUID } from 'crypto';
import { assertMoneyInvariants } from './helpers/money-invariants';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { ShipmentService } from './../src/modules/shipments/shipments.service';
import { ShipmentDeliveryService } from './../src/modules/shipments/shipment-delivery.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPickupService } from './../src/modules/orders/order-pickup.service';
import { SepayQrExpiryCron } from './../src/modules/orders/sepay-qr-expiry.cron';
import {
  DeliveryCollectionMethod,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from './../src/common/constants/payment-method';
import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import { CarrierType } from './../src/common/constants/shipment-status';
import { OrderEventSource } from './../src/common/constants/order-event-type';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

const MIN = 60_000;
const LATE = () => new Date(Date.now() + 16 * MIN);
const SOON = () => new Date(Date.now() + 10 * MIN);

/**
 * Mã QR SePay hết hạn sau 15 phút (orders/sepay-qr.ts) trên Postgres thật: cron huỷ đơn quầy và đánh dấu EXPIRED, tạo lại mã, tiền về muộn (chốt hoặc từ chối + báo chủ shop), sổ giao dịch chống trùng, và nút "Hủy đơn này" của quầy.
 * Thời gian giả bằng tham số `now` của cron / webhook; lúc đọc qua HTTP thì lùi giờ của dòng trong DB. Hàng vào kho bằng `openLot`.
 * Lưu ý: cron quét mọi tenant, nên các đơn quầy chờ QR cũ trong DB dùng chung cũng bị huỷ khi `now` giả được đẩy lên.
 */
describe('SePay QR expiry', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inventory: InventoryService;
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let shipments: ShipmentService;
  let delivery: ShipmentDeliveryService;
  let pickups: OrderPickupService;
  let cron: SepayQrExpiryCron;
  const notify = jest.fn();
  const emit = jest.fn();

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const cashierId = randomUUID(); // chỉ có orders:create
  const otherCashierId = randomUUID();
  const managerId = randomUUID(); // có orders:update
  const driverId = randomUUID();
  const roleId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const tableId = randomUUID();
  const customerId = randomUUID();

  const base = {
    tenantId,
    roleId: null,
    shiftSupervision: null,
    email: null,
    displayName: 'x',
  };
  const owner = {
    ...base,
    userId: ownerId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
    phoneNumber: `qr-${ownerId}`,
  } as unknown as AuthUser;
  const staffAt = (
    userId: string,
    permissions: string[],
    where: { branchId?: string; warehouseId?: string } = { branchId },
  ) =>
    ({
      ...base,
      userId,
      systemRole: SystemRole.STAFF,
      permissions: new Set(permissions),
      branchId: where.branchId ?? null,
      warehouseId: where.warehouseId ?? null,
      phoneNumber: `qr-${userId}`,
    }) as unknown as AuthUser;
  const cashier = staffAt(cashierId, ['orders:create', 'orders:read']);
  const otherCashier = staffAt(otherCashierId, ['orders:create']);
  const manager = staffAt(managerId, ['orders:create', 'orders:update']);
  const driver = staffAt(driverId, ['shipments:deliver'], {
    warehouseId,
  });

  const branchStock = async () =>
    (
      await prisma.inventory.findFirstOrThrow({
        where: { tenantId, locationId: branchId, productItemId: tableId },
      })
    ).stock;

  const posSale = (user: AuthUser = owner) =>
    orders.createPosSale(user, tenantId, {
      branchId,
      paymentMethod: PaymentMethod.SEPAY,
      items: [{ productItemId: tableId, quantity: 1 }],
    });
  const orderOf = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });
  const eventsOf = (orderId: string, type?: string) =>
    prisma.orderEvent.findMany({
      where: { orderId, ...(type ? { type } : {}) },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  const paymentsOf = (orderId: string) =>
    prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  const ledgerOf = (txId: string) =>
    prisma.sepayTransaction.findFirst({
      where: { tenantId, sepayTransactionId: txId },
    });
  const incomeOf = (orderId: string) =>
    prisma.cashFlow.count({ where: { orderId, flowType: 'INCOME' } });
  const lateNotices = () =>
    notify.mock.calls.filter(
      ([input]: [{ type: string }]) => input.type === 'ORDER_LATE_TRANSFER',
    );

  /** Đơn giao tận nơi đã giao với QR: RECEIVED, khoản SEPAY chờ. Còn phải thu 1000 (không cọc). */
  async function deliveredByQr() {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `QRD-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: managerId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType: FulfillmentType.HOME_DELIVERY,
        grandTotal: 1000,
        depositAmount: 0,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy',
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-QR',
              quantity: 1,
              listUnitPrice: 1000,
              unitPrice: 1000,
              lineTotal: 1000,
              sourceLocationId: warehouseId,
            },
          ],
        },
      },
    });
    await fulfillments.packOrder(owner, id, {});
    const created = await shipments.create(owner, tenantId, {
      orderId: id,
      carrierType: CarrierType.INTERNAL,
      driverId,
    });
    await shipments.pickUp(driver, tenantId, created.id, {});
    await shipments.shipOrder(owner, tenantId, id, {});
    const shipment = await delivery.deliver(driver, tenantId, created.id, {
      proofPhotoUrls: ['https://example.com/p.jpg'],
      paymentMethod: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      collectedAmount: 1000,
    });
    return {
      orderId: id,
      shipmentId: created.id,
      reference: shipment.payment!.reference,
    };
  }

  /** Lùi giờ phát của khoản QR để nó hết hạn khi đọc qua HTTP. */
  const expirePayment = (reference: string) =>
    prisma.payment.update({
      where: { paymentReference: reference },
      data: {
        expiresAt: new Date(Date.now() - MIN),
        createdAt: new Date(Date.now() - 16 * MIN),
      },
    });

  async function packedPickup() {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `QRP-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: managerId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType: FulfillmentType.STORE_PICKUP,
        grandTotal: 1000,
        depositAmount: 0,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-QR',
              quantity: 1,
              listUnitPrice: 1000,
              unitPrice: 1000,
              lineTotal: 1000,
              sourceLocationId: warehouseId,
            },
          ],
        },
      },
    });
    await fulfillments.packOrder(owner, id, {});
    return id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    inventory = app.get(InventoryService);
    orders = app.get(OrderService);
    fulfillments = app.get(FulfillmentService);
    shipments = app.get(ShipmentService);
    delivery = app.get(ShipmentDeliveryService);
    pickups = app.get(OrderPickupService);
    cron = app.get(SepayQrExpiryCron);
    jest
      .spyOn(app.get(NotificationService), 'notify')
      .mockImplementation(notify.mockResolvedValue({ notified: 0 }));
    jest.spyOn(app.get(RealtimeGateway), 'emitToRoom').mockImplementation(emit);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'qr-expiry-e2e',
        bankingBankName: 'VCB',
        bankingAccountNumber: '0123456799',
        bankingAccountName: 'NOI THAT DEMO',
        bankingSepayLinkedAt: new Date(),
      },
    });
    await prisma.role.create({
      data: {
        id: roleId,
        tenantId,
        name: 'Shipper',
        permissions: { create: { resource: 'shipments', action: 'deliver' } },
      },
    });
    await prisma.user.createMany({
      data: [
        [ownerId, SystemRole.TENANT_OWNER, null],
        [cashierId, SystemRole.STAFF, null],
        [otherCashierId, SystemRole.STAFF, null],
        [managerId, SystemRole.STAFF, null],
        [driverId, SystemRole.STAFF, roleId],
      ].map(([id, systemRole, role]) => ({
        id: id as string,
        tenantId,
        roleId: role,
        phoneNumber: `qr-${id as string}`,
        systemRole: systemRole as string,
      })),
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN qr', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho qr', type: 'WAREHOUSE' },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: tableId,
        tenantId,
        productId,
        productName: 'Bàn',
        productCode: `QR-${tableId}`,
        retailPrice: 1000,
        costPrice: 100,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    for (const locationId of [branchId, warehouseId]) {
      await prisma.$transaction((tx) =>
        inventory.openLot(tx, {
          tenantId,
          locationId,
          productItemId: tableId,
          quantity: 100,
          unitCost: 100,
          sourceType: LotSourceType.SUPPLIER,
          ledger: {
            type: InventoryTxType.IMPORT,
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: 'qr-expiry-e2e',
          },
        }),
      );
    }
  });

  beforeEach(() => {
    notify.mockClear();
    emit.mockClear();
  });

  afterAll(async () => {
    await prisma.sepayTransaction.deleteMany({ where: { tenantId } });
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } }); // order_events: Cascade
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.role.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await app.close();
  });

  describe('đơn quầy chờ QR', () => {
    it('hands out a code with its deadline, and the cron cancels it only after 15 minutes', async () => {
      const before = await branchStock();
      const sale = await posSale();
      expect(sale.qrUrl).toContain('img.vietqr.io');
      const createdAt = sale.order.createdAt.getTime();
      expect(new Date(sale.qrExpiresAt!).getTime()).toBe(createdAt + 15 * MIN);
      const id = sale.order.id;
      expect(await branchStock()).toBe(before - 1);

      await cron.expireStale(SOON());
      expect((await orderOf(id)).status).toBe(OrderStatus.PENDING);

      emit.mockClear();
      await cron.expireStale(LATE());
      const order = await orderOf(id);
      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.cancelReason).toBe('QR hết hạn');
      expect(order.cancelledById).toBeNull();
      expect(order.cancelledAt).not.toBeNull();
      expect(await branchStock()).toBe(before);

      const reversal = await prisma.inventoryTransaction.count({
        where: {
          tenantId,
          referenceId: id,
          type: InventoryTxType.SALE_REVERSAL,
        },
      });
      expect(reversal).toBeGreaterThan(0);
      const invoice = await prisma.invoice.findFirst({
        where: { orderId: id },
      });
      expect(invoice?.status).toBe('CANCELLED');

      const [event] = await eventsOf(id, 'CANCELLED');
      expect(event).toMatchObject({
        source: OrderEventSource.SYSTEM,
        actorId: null,
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.CANCELLED,
      });
      expect(emit).toHaveBeenCalledWith(
        `tenant:${tenantId}`,
        'order:cancelled',
        { orderId: id, status: 'CANCELLED', reason: 'QR_EXPIRED' },
      );

      // Chạy lần nữa không làm gì thêm.
      await cron.expireStale(LATE());
      expect(await eventsOf(id, 'CANCELLED')).toHaveLength(1);
      expect(await branchStock()).toBe(before);
    });

    it('two cron runs at once cancel the order once and restock once', async () => {
      const before = await branchStock();
      const { order } = await posSale();
      await Promise.all([cron.expireStale(LATE()), cron.expireStale(LATE())]);
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED);
      expect(await eventsOf(order.id, 'CANCELLED')).toHaveLength(1);
      expect(await branchStock()).toBe(before);
    });
  });

  describe('POST /orders/pos/:id/cancel', () => {
    it("lets a create-only cashier cancel their own sale, and not someone else's", async () => {
      const before = await branchStock();
      const own = await posSale(cashier);
      await expect(
        orders.cancelPosSale(otherCashier, tenantId, own.order.id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
      emit.mockClear();
      const cancelled = await orders.cancelPosSale(
        cashier,
        tenantId,
        own.order.id,
        {},
      );
      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.cancelReason).toBe('Khách không thanh toán QR');
      expect(cancelled.cancelledById).toBe(cashierId);
      expect(await branchStock()).toBe(before);
      const [event] = await eventsOf(own.order.id, 'CANCELLED');
      expect(event).toMatchObject({
        source: OrderEventSource.USER,
        actorId: cashierId,
      });
      expect(emit).toHaveBeenCalledWith(
        `tenant:${tenantId}`,
        'order:cancelled',
        { orderId: own.order.id, status: 'CANCELLED', reason: 'MANUAL' },
      );

      // Lần hai: đơn không còn chờ QR.
      await expect(
        orders.cancelPosSale(cashier, tenantId, own.order.id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_NOT_PENDING_SEPAY },
      });
    });

    it("lets a holder of orders:update cancel anyone's sale, with their own reason", async () => {
      const sale = await posSale(cashier);
      const cancelled = await orders.cancelPosSale(
        manager,
        tenantId,
        sale.order.id,
        {
          reason: 'Khách đổi ý',
        },
      );
      expect(cancelled.cancelReason).toBe('Khách đổi ý');
      expect(cancelled.cancelledById).toBe(managerId);
    });
  });

  describe('thu khi giao', () => {
    it('shows an expired code as EXPIRED with no URL, and the cron marks it EXPIRED without touching the order', async () => {
      const { orderId, shipmentId, reference } = await deliveredByQr();
      const live = await shipments.findOne(owner, tenantId, shipmentId);
      expect(live.payment).toMatchObject({ status: 'PENDING', expired: false });
      expect(live.payment!.qrUrl).toContain('img.vietqr.io');

      await expirePayment(reference);
      const view = await shipments.findOne(owner, tenantId, shipmentId);
      expect(view.payment).toMatchObject({
        status: 'EXPIRED',
        qrUrl: null,
        expired: true,
      });

      const events = (await eventsOf(orderId)).length;
      await cron.expireStale();
      const [payment] = await paymentsOf(orderId);
      expect(payment.status).toBe(PaymentRecordStatus.EXPIRED);
      expect((await orderOf(orderId)).status).toBe(OrderStatus.RECEIVED);
      expect(await eventsOf(orderId)).toHaveLength(events);
    });

    it('reissueQr replaces an expired code, and returns the same code while it is live', async () => {
      const { orderId, shipmentId, reference } = await deliveredByQr();
      const same = await delivery.reissueQr(driver, tenantId, shipmentId);
      expect(same.payment!.reference).toBe(reference);

      await expirePayment(reference);
      const fresh = await delivery.reissueQr(driver, tenantId, shipmentId);
      expect(fresh.payment!.reference).not.toBe(reference);
      expect(fresh.payment).toMatchObject({
        status: 'PENDING',
        expired: false,
      });
      expect(fresh.payment!.qrUrl).toContain(fresh.payment!.reference);
      const rows = await paymentsOf(orderId);
      expect(rows.map((p) => p.status)).toEqual([
        PaymentRecordStatus.CANCELLED,
        PaymentRecordStatus.PENDING,
      ]);

      // Người ngoài cuộc không tạo lại được.
      await expect(
        delivery.reissueQr(staffAt(randomUUID(), []), tenantId, shipmentId),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });

    it('lets the shipper switch to cash after the code expired', async () => {
      const { orderId, shipmentId, reference } = await deliveredByQr();
      await expirePayment(reference);
      await delivery.payCash(driver, tenantId, shipmentId, {});
      const rows = await paymentsOf(orderId);
      expect(rows.find((p) => p.method === PaymentMethod.SEPAY)?.status).toBe(
        PaymentRecordStatus.CANCELLED,
      );
      expect(rows.find((p) => p.method === PaymentMethod.CASH)?.status).toBe(
        PaymentRecordStatus.PAID,
      );
    });

    it('accepts a late transfer while the order still waits: COMPLETED, event flagged, ledger SETTLED_LATE', async () => {
      const { orderId, reference } = await deliveredByQr();
      await delivery.settleSepayBalance(
        tenantId,
        reference,
        'LATE-DELIV',
        1000,
        LATE(),
      );
      const order = await orderOf(orderId);
      expect(order.status).toBe(OrderStatus.COMPLETED);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.PAID);
      const [paid] = await eventsOf(orderId, 'QR_PAID');
      expect(paid.metadata).toMatchObject({ lateAfterExpiry: true });
      expect((await ledgerOf('LATE-DELIV'))?.outcome).toBe('SETTLED_LATE');
      expect(await incomeOf(orderId)).toBe(1);
    });

    it('rejects and notifies the owner when the transfer hits a code the shipper already replaced by cash', async () => {
      const { orderId, shipmentId, reference } = await deliveredByQr();
      await delivery.payCash(driver, tenantId, shipmentId, {});
      notify.mockClear();
      await delivery.settleSepayBalance(
        tenantId,
        reference,
        'LATE-CASH',
        1000,
        LATE(),
      );
      expect(await ledgerOf('LATE-CASH')).toMatchObject({
        outcome: 'REJECTED',
        rejectReason: 'PAYMENT_SUPERSEDED',
      });
      expect(lateNotices()).toHaveLength(1);
      expect(await incomeOf(orderId)).toBe(0);
      expect((await orderOf(orderId)).status).toBe(OrderStatus.RECEIVED);
    });

    it('rejects a transfer to the old reference after a reissue, and settles the new one', async () => {
      const { orderId, shipmentId, reference } = await deliveredByQr();
      await expirePayment(reference);
      const fresh = await delivery.reissueQr(driver, tenantId, shipmentId);
      notify.mockClear();
      await delivery.settleSepayBalance(tenantId, reference, 'OLD-REF', 1000);
      expect((await ledgerOf('OLD-REF'))?.rejectReason).toBe(
        'PAYMENT_SUPERSEDED',
      );
      expect(lateNotices()).toHaveLength(1);
      expect((await orderOf(orderId)).status).toBe(OrderStatus.RECEIVED);

      await delivery.settleSepayBalance(
        tenantId,
        fresh.payment!.reference,
        'NEW-REF',
        1000,
      );
      expect((await orderOf(orderId)).status).toBe(OrderStatus.COMPLETED);
    });

    it('is idempotent on the SePay transaction id: one cash flow and one notice, however often it is replayed', async () => {
      const { orderId, reference } = await deliveredByQr();
      notify.mockClear();
      await delivery.settleSepayBalance(tenantId, reference, 'TX-ONCE', 1000);
      await delivery.settleSepayBalance(tenantId, reference, 'TX-ONCE', 1000);
      await Promise.all([
        delivery.settleSepayBalance(tenantId, reference, 'TX-ONCE', 1000),
        delivery.settleSepayBalance(tenantId, reference, 'TX-ONCE', 1000),
      ]);
      expect(await incomeOf(orderId)).toBe(1);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await eventsOf(orderId, 'QR_PAID')).toHaveLength(1);
    });
  });

  describe('thu tại quầy (khách tới lấy)', () => {
    it('never returns an expired code: collect again gives a fresh reference, and a live one is reused', async () => {
      const id = await packedPickup();
      const first = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(first.payment!.expiresAt).toBeDefined();
      const again = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(again.payment!.reference).toBe(first.payment!.reference);

      await expirePayment(first.payment!.reference);
      const fresh = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      expect(fresh.payment!.reference).not.toBe(first.payment!.reference);
      const rows = await paymentsOf(id);
      expect(rows.map((p) => p.status)).toEqual([
        PaymentRecordStatus.CANCELLED,
        PaymentRecordStatus.PENDING,
      ]);
    });

    it('collects cash after the code expired, cancelling the expired QR', async () => {
      const id = await packedPickup();
      const qr = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      await expirePayment(qr.payment!.reference);
      await cron.expireStale();
      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });
      const rows = await paymentsOf(id);
      expect(rows.find((p) => p.method === PaymentMethod.SEPAY)?.status).toBe(
        PaymentRecordStatus.CANCELLED,
      );
      expect((await orderOf(id)).paymentStatus).toBe(OrderPaymentStatus.PAID);
      expect(
        rows.some(
          (p) =>
            p.kind === PaymentKind.BALANCE && p.method === PaymentMethod.CASH,
        ),
      ).toBe(true);
    });
  });

  describe('webhook đơn quầy', () => {
    it('accepts a late transfer for a sale the cron has not cancelled yet: COMPLETED, flagged late', async () => {
      const { order } = await posSale();
      const result = await orders.completeSepayOrder(
        tenantId,
        order.paymentReference!,
        'POS-LATE',
        1000,
        LATE(),
      );
      expect(result?.message).toBe('Order payment confirmed');
      expect((await orderOf(order.id)).status).toBe(OrderStatus.COMPLETED);
      const [paid] = await eventsOf(order.id, 'QR_PAID');
      expect(paid.metadata).toMatchObject({ lateAfterExpiry: true });
      expect((await ledgerOf('POS-LATE'))?.outcome).toBe('SETTLED_LATE');
      expect(await incomeOf(order.id)).toBe(1);
    });

    it('rejects a transfer for a sale the cron already cancelled: no cash flow, owner notified, ledger REJECTED', async () => {
      const { order } = await posSale();
      await cron.expireStale(LATE());
      notify.mockClear();
      const result = await orders.completeSepayOrder(
        tenantId,
        order.paymentReference!,
        'POS-CANCELLED',
        1000,
        LATE(),
      );
      expect(result?.message).toContain('owner notified');
      expect((await orderOf(order.id)).status).toBe(OrderStatus.CANCELLED);
      expect(await incomeOf(order.id)).toBe(0);
      expect(lateNotices()).toHaveLength(1);
      expect(await ledgerOf('POS-CANCELLED')).toMatchObject({
        outcome: 'REJECTED',
        rejectReason: 'ORDER_CANCELLED',
      });

      // Cùng giao dịch gọi lại: đã vào sổ, không báo lại.
      const replay = await orders.completeSepayOrder(
        tenantId,
        order.paymentReference!,
        'POS-CANCELLED',
        1000,
        LATE(),
      );
      expect(replay?.message).toBe('Duplicate transaction');
      expect(lateNotices()).toHaveLength(1);
    });

    it('returns null for a reference that is not a till sale, so the webhook falls through to the delivery payments', async () => {
      expect(
        await orders.completeSepayOrder(tenantId, 'ORD0000000000', 'X', 1),
      ).toBeNull();
    });
  });

  // Cuối suite: sổ tiền của tenant này đúng mọi bất biến (test/helpers/money-invariants.ts).
  it('leaves the money ledger consistent', async () => {
    await assertMoneyInvariants(prisma, tenantId);
  });
});
