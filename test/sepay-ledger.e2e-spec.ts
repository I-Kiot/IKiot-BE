import 'dotenv/config';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
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
import { OrderRemittanceService } from './../src/modules/orders/order-remittance.service';
import { SepayQrExpiryCron } from './../src/modules/orders/sepay-qr-expiry.cron';
import { OrderExcessRefundService } from './../src/modules/orders/order-excess-refund.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { SepayTransactionService } from './../src/modules/sepay-transactions/sepay-transactions.service';
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
  RemittanceStatus,
} from './../src/common/constants/order-status';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import { CarrierType } from './../src/common/constants/shipment-status';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';
import { assertMoneyInvariants } from './helpers/money-invariants';
import { deleteTenantMoneyTrail } from './helpers/cleanup-money';

const MIN = 60_000;
const LATE = () => new Date(Date.now() + 16 * MIN);
const ACCOUNT = '0987000111';
const WEBHOOK_KEY = 'ledger-webhook-key';
const SHARED_KEY = 'ledger-shared-key';

/**
 * Phase 3-4 của sổ tiền (Postgres thật): đơn quầy có Payment (FULL / CHANGE / QR), một đường chốt SePay chung cho quầy và thu khi giao, chuyển thiếu là khoản trả một phần, trả dư ghi lại,
 * mọi giao dịch SePay đều vào sổ (không mã, mã lạ, không có id, không có shop) và tiền chưa gắn đơn vào sổ thu chi, nộp tiền shipper cho đơn đã RETURNED, cùng route xử lý sổ.
 */
describe('POS payments + SePay ledger', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inventory: InventoryService;
  let orders: OrderService;
  let fulfillments: FulfillmentService;
  let shipments: ShipmentService;
  let delivery: ShipmentDeliveryService;
  let pickups: OrderPickupService;
  let remittances: OrderRemittanceService;
  let sepayLedger: SepayTransactionService;
  let excessRefunds: OrderExcessRefundService;
  let reads: OrderReadService;
  let cron: SepayQrExpiryCron;
  let http: () => ReturnType<typeof request>;
  const notify = jest.fn();
  const notifySystem = jest.fn();
  const emit = jest.fn();

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const cashierId = randomUUID();
  const driverId = randomUUID();
  const managerId = randomUUID();
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
    phoneNumber: `lg-${ownerId}`,
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
      phoneNumber: `lg-${userId}`,
    }) as unknown as AuthUser;
  const cashier = staffAt(cashierId, ['orders:create', 'orders:read']);
  const driver = staffAt(driverId, ['shipments:deliver'], { warehouseId });

  let txCounter = 880_000;
  const nextTx = () => String(++txCounter);

  const posSale = (
    method: string,
    extra: { customerPay?: number; user?: AuthUser } = {},
  ) =>
    orders.createPosSale(extra.user ?? owner, tenantId, {
      branchId,
      paymentMethod: method,
      customerPay: extra.customerPay,
      items: [{ productItemId: tableId, quantity: 1 }],
    });
  const orderOf = (id: string) =>
    prisma.order.findUniqueOrThrow({ where: { id } });
  const paymentsOf = (orderId: string) =>
    prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  const flowsOf = (orderId: string) =>
    prisma.cashFlow.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  const eventsOf = (orderId: string, type?: string) =>
    prisma.orderEvent.findMany({
      where: { orderId, ...(type ? { type } : {}) },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
  const ledger = (where: Record<string, unknown>) =>
    prisma.sepayTransaction.findMany({
      where: { tenantId, ...where },
      orderBy: { createdAt: 'asc' },
    });
  const noticesOf = (type: string) =>
    notify.mock.calls.filter(
      ([input]: [{ type: string }]) => input.type === type,
    );

  /** Webhook SePay thật qua HTTP (key riêng của shop). */
  const webhook = (
    body: Record<string, unknown>,
    key: string = WEBHOOK_KEY,
    account: string = ACCOUNT,
  ) =>
    http()
      .post('/webhook/sepay/order')
      .set({ Authorization: `Apikey ${key}` })
      .send({ transferType: 'in', accountNumber: account, ...body })
      .expect(200);

  async function deliveredBy(method: string, amount = 1000) {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `LGD-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: managerId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType: FulfillmentType.HOME_DELIVERY,
        grandTotal: amount,
        depositAmount: 0,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy',
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-LG',
              quantity: 1,
              listUnitPrice: amount,
              unitPrice: amount,
              lineTotal: amount,
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
      paymentMethod: method,
      collectedAmount: amount,
    });
    return {
      orderId: id,
      shipmentId: created.id,
      reference: shipment.payment?.reference ?? null,
    };
  }

  async function packedPickup(amount = 1000) {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `LGP-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: managerId,
        status: OrderStatus.CONFIRMED,
        fulfillmentType: FulfillmentType.STORE_PICKUP,
        grandTotal: amount,
        depositAmount: 0,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-LG',
              quantity: 1,
              listUnitPrice: amount,
              unitPrice: amount,
              lineTotal: amount,
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
    http = () => request(app.getHttpServer() as App);
    prisma = app.get(PrismaService);
    inventory = app.get(InventoryService);
    orders = app.get(OrderService);
    fulfillments = app.get(FulfillmentService);
    shipments = app.get(ShipmentService);
    delivery = app.get(ShipmentDeliveryService);
    pickups = app.get(OrderPickupService);
    remittances = app.get(OrderRemittanceService);
    sepayLedger = app.get(SepayTransactionService);
    excessRefunds = app.get(OrderExcessRefundService);
    reads = app.get(OrderReadService);
    cron = app.get(SepayQrExpiryCron);
    const notifications = app.get(NotificationService);
    jest
      .spyOn(notifications, 'notify')
      .mockImplementation(notify.mockResolvedValue({ notified: 0 }));
    jest
      .spyOn(notifications, 'notifySystem')
      .mockImplementation(notifySystem.mockResolvedValue(undefined));
    jest.spyOn(app.get(RealtimeGateway), 'emitToRoom').mockImplementation(emit);

    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'sepay-ledger-e2e',
        bankingBankName: 'VCB',
        bankingAccountNumber: ACCOUNT,
        bankingAccountName: 'NOI THAT DEMO',
        bankingSepayLinkedAt: new Date(),
        bankingSepayWebhookApiKey: WEBHOOK_KEY,
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
        [managerId, SystemRole.STAFF, null],
        [driverId, SystemRole.STAFF, roleId],
      ].map(([id, systemRole, role]) => ({
        id: id as string,
        tenantId,
        roleId: role,
        phoneNumber: `lg-${id as string}`,
        systemRole: systemRole as string,
      })),
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN lg', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho lg', type: 'WAREHOUSE' },
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
        productCode: `LG-${tableId}`,
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
          quantity: 200,
          unitCost: 100,
          sourceType: LotSourceType.SUPPLIER,
          ledger: {
            type: InventoryTxType.IMPORT,
            referenceType: InventoryRefType.STOCK_MOVEMENT,
            referenceId: 'sepay-ledger-e2e',
          },
        }),
      );
    }
  });

  beforeEach(() => {
    notify.mockClear();
    notifySystem.mockClear();
    emit.mockClear();
  });

  afterAll(async () => {
    delete process.env.SEPAY_ORDER_WEBHOOK_API_KEY;
    await prisma.sepayTransaction.deleteMany({
      where: { tenantId: null, accountNumber: '0987999888' },
    });
    await deleteTenantMoneyTrail(prisma, tenantId);
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({
      where: { tenantId, refundOfPaymentId: { not: null } },
    });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
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

  // ───────────────────────── Phase 3: đơn quầy có Payment ─────────────────────────
  describe('đơn quầy nhận tiền ngay', () => {
    it('cash with change: FULL (the cash handed over) + CHANGE (pointing back at it), each with its own cash flow linked to the order', async () => {
      const { order } = await posSale(PaymentMethod.CASH, {
        customerPay: 1500,
      });
      expect(order.status).toBe(OrderStatus.COMPLETED);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.PAID);
      const payments = await paymentsOf(order.id);
      expect(payments.map((p) => [p.kind, p.status, Number(p.amount)])).toEqual(
        [
          [PaymentKind.FULL, 'PAID', 1500],
          [PaymentKind.CHANGE, 'PAID', 500],
        ],
      );
      expect(payments[1].refundOfPaymentId).toBe(payments[0].id);
      const flows = await flowsOf(order.id);
      expect(
        flows.map((f) => [f.category, f.flowType, f.fund, Number(f.amount)]),
      ).toEqual([
        ['ORDER_PAYMENT', 'INCOME', 'DRAWER', 1500],
        ['SALE_CHANGE', 'EXPENSE', 'DRAWER', 500],
      ]);
      expect(flows.every((f) => f.orderId === order.id)).toBe(true);
      expect(flows.map((f) => f.paymentId).sort()).toEqual(
        payments.map((p) => p.id).sort(),
      );
      // Tiền giữ = tiền vào − thối = tổng đơn.
      expect(Number(order.grandTotal)).toBe(1000);
      expect(order.payments).toHaveLength(2);
    });

    it('a non-cash method records one FULL payment in the bank fund and never a change', async () => {
      const { order } = await posSale(PaymentMethod.BANK_TRANSFER, {
        customerPay: 1000,
      });
      const payments = await paymentsOf(order.id);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        kind: PaymentKind.FULL,
        method: PaymentMethod.BANK_TRANSFER,
      });
      const [flow] = await flowsOf(order.id);
      expect(flow).toMatchObject({ fund: 'BANK', category: 'ORDER_PAYMENT' });
    });

    it('stores the subtotal on a till order (invoices used to show 0)', async () => {
      const { order } = await posSale(PaymentMethod.CASH, {
        customerPay: 1000,
      });
      expect(Number((await orderOf(order.id)).subtotal)).toBe(1000);
    });
  });

  describe('đơn quầy chờ SePay', () => {
    it('opens a FULL SEPAY payment waiting for the transfer (amount = requested, 15 minute deadline)', async () => {
      const { order, qrExpiresAt } = await posSale(PaymentMethod.SEPAY);
      expect(order.status).toBe(OrderStatus.PENDING);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
      const [qr] = await paymentsOf(order.id);
      expect(qr).toMatchObject({
        kind: PaymentKind.FULL,
        method: PaymentMethod.SEPAY,
        status: PaymentRecordStatus.PENDING,
        paymentReference: order.paymentReference,
      });
      expect(Number(qr.amount)).toBe(1000);
      expect(Number(qr.requestedAmount)).toBe(1000);
      expect(qr.expiresAt!.getTime()).toBe(
        order.createdAt.getTime() + 15 * MIN,
      );
      expect(new Date(qrExpiresAt!).getTime()).toBe(qr.expiresAt!.getTime());
      expect(await flowsOf(order.id)).toHaveLength(0);
    });

    it('the webhook settles it exactly: COMPLETED, FULL PAID, one cash flow, ledger SETTLED', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      const res = await webhook({
        id: Number(txId),
        content: `Thanh toan ${order.paymentReference}`,
        transferAmount: 1000,
      });
      expect(res.body).toMatchObject({
        success: true,
        message: 'Order payment confirmed',
      });
      const settled = await orderOf(order.id);
      expect(settled).toMatchObject({
        status: OrderStatus.COMPLETED,
        paymentStatus: OrderPaymentStatus.PAID,
        sepayTransactionId: txId,
      });
      expect(settled.completedAt).not.toBeNull();
      const [qr] = await paymentsOf(order.id);
      expect(qr).toMatchObject({
        status: PaymentRecordStatus.PAID,
        sepayTransactionId: txId,
      });
      const flows = await flowsOf(order.id);
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({
        category: 'ORDER_PAYMENT',
        fund: 'BANK',
        paymentId: qr.id,
        createdById: null,
      });
      expect((await ledger({ sepayTransactionId: txId }))[0]).toMatchObject({
        outcome: 'SETTLED',
        paymentId: qr.id,
        orderId: order.id,
      });
      const invoice = await prisma.invoice.findFirst({
        where: { orderId: order.id },
      });
      expect(invoice?.status).toBe('ISSUED');
      expect(emit).toHaveBeenCalledWith(
        `tenant:${tenantId}`,
        'order:paid',
        expect.objectContaining({
          orderId: order.id,
          paidAmount: 1000,
          partial: false,
          due: 0,
          paymentStatus: 'PAID',
        }),
      );
    });

    it('a short transfer is a partial payment: the order stays PENDING and PARTIALLY_PAID, the cashier is told, the cron leaves it alone', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      const res = await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 400,
      });
      expect(res.body).toMatchObject({
        success: true,
        message: 'Partial payment recorded',
      });
      const pending = await orderOf(order.id);
      expect(pending.status).toBe(OrderStatus.PENDING);
      expect(pending.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
      expect(pending.completedAt).toBeNull();
      const [qr] = await paymentsOf(order.id);
      expect(qr.status).toBe(PaymentRecordStatus.PAID);
      expect(Number(qr.amount)).toBe(400);
      expect(Number(qr.requestedAmount)).toBe(1000);
      expect((await ledger({ sepayTransactionId: txId }))[0].outcome).toBe(
        'SETTLED_PARTIAL',
      );
      const [flow] = await flowsOf(order.id);
      expect(Number(flow.amount)).toBe(400);
      const [paid] = await eventsOf(order.id, 'QR_PAID');
      expect(paid.metadata).toMatchObject({
        partial: true,
        requested: 1000,
        amount: 400,
        due: 600,
      });
      expect(paid.toStatus).toBeNull();
      expect(noticesOf('ORDER_PARTIAL_TRANSFER')).toHaveLength(1);
      expect(emit).toHaveBeenCalledWith(
        `tenant:${tenantId}`,
        'order:paid',
        expect.objectContaining({
          partial: true,
          due: 600,
          paymentStatus: 'PARTIALLY_PAID',
        }),
      );
      // Tiền của khách đã về: quá hạn QR cũng không được tự huỷ đơn.
      await cron.expireStale(LATE());
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PENDING);
    });

    it('needs-action is one rule: a SETTLED_PARTIAL row is listed while its order is short, and drops out once the order is PAID', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 400,
      });
      const [row] = await ledger({ sepayTransactionId: txId });
      const listedIds = async () =>
        (
          await sepayLedger.findAll(tenantId, {
            page: 1,
            limit: 100,
            unresolved: true,
          })
        ).data.map((r) => r.id);
      expect(await listedIds()).toContain(row.id);
      const derivedStatus = (await orderOf(order.id)).paymentStatus;
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: OrderPaymentStatus.PAID },
      });
      expect(await listedIds()).not.toContain(row.id);
      await prisma.order.update({
        where: { id: order.id },
        data: { paymentStatus: derivedStatus },
      });
    });

    it('POST /orders/pos/:id/qr issues a QR for the remainder, and the transfer for it completes the order (2 payments, 2 cash flows)', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await webhook({
        id: Number(nextTx()),
        content: order.paymentReference,
        transferAmount: 400,
      });

      const issued = await orders.createPosQr(owner, tenantId, order.id);
      expect(issued.amount).toBe(600);
      expect(issued.qrUrl).toContain('img.vietqr.io');
      expect(new Date(issued.qrExpiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      const rows = await paymentsOf(order.id);
      expect(rows.map((p) => [p.kind, p.status])).toEqual([
        [PaymentKind.FULL, 'PAID'],
        [PaymentKind.BALANCE, 'PENDING'],
      ]);
      const remainder = rows[1];
      expect(Number(remainder.requestedAmount)).toBe(600);
      expect(remainder.paymentReference).not.toBe(order.paymentReference);
      expect(issued.qrUrl).toContain(remainder.paymentReference!);

      // Bấm lần nữa khi mã còn sống đúng số tiền: trả nguyên mã, không đổi.
      const again = await orders.createPosQr(owner, tenantId, order.id);
      expect(again.qrUrl).toBe(issued.qrUrl);
      expect(await paymentsOf(order.id)).toHaveLength(2);

      await webhook({
        id: Number(nextTx()),
        content: `CK ${remainder.paymentReference}`,
        transferAmount: 600,
      });
      const done = await orderOf(order.id);
      expect(done).toMatchObject({
        status: OrderStatus.COMPLETED,
        paymentStatus: OrderPaymentStatus.PAID,
      });
      expect((await paymentsOf(order.id)).map((p) => p.status)).toEqual([
        'PAID',
        'PAID',
      ]);
      expect((await flowsOf(order.id)).map((f) => Number(f.amount))).toEqual([
        400, 600,
      ]);
      expect(
        await prisma.invoice.count({
          where: { orderId: order.id, status: 'ISSUED' },
        }),
      ).toBe(1);
    });

    it('refuses a QR for a sale that is not waiting, or that someone else rang up', async () => {
      const cash = await posSale(PaymentMethod.CASH, { customerPay: 1000 });
      await expect(
        orders.createPosQr(owner, tenantId, cash.order.id),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_NOT_PENDING_SEPAY },
      });
      const others = await posSale(PaymentMethod.SEPAY);
      await expect(
        orders.createPosQr(cashier, tenantId, others.order.id),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
      await orders.cancelPosSale(owner, tenantId, others.order.id, {});
    });

    it('payOffline takes only the remainder after a short transfer: BALANCE + CHANGE, the waiting QR cancelled', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await webhook({
        id: Number(nextTx()),
        content: order.paymentReference,
        transferAmount: 400,
      });
      const issued = await orders.createPosQr(owner, tenantId, order.id);
      expect(issued.amount).toBe(600);

      const done = await orders.payOffline(owner, tenantId, order.id, ownerId, {
        paymentMethod: PaymentMethod.CASH,
        customerPay: 1000,
      });
      expect(done.status).toBe(OrderStatus.COMPLETED);
      expect(done.paymentStatus).toBe(OrderPaymentStatus.PAID);
      const rows = await paymentsOf(order.id);
      expect(
        rows.map((p) => [p.kind, p.method, p.status, Number(p.amount)]),
      ).toEqual([
        ['FULL', 'SEPAY', 'PAID', 400],
        ['BALANCE', 'SEPAY', 'CANCELLED', 600],
        ['BALANCE', 'CASH', 'PAID', 1000],
        ['CHANGE', 'CASH', 'PAID', 400],
      ]);
      expect(rows[1].cancelledById).toBe(ownerId);
      expect(rows[1].cancelledAt).not.toBeNull();
      const [event] = await eventsOf(order.id, 'PAID_OFFLINE');
      expect(event.metadata).toMatchObject({
        amount: 1000,
        change: 400,
        method: 'CASH',
        grandTotal: 1000,
      });
      // Mã QR cũ về muộn: khoản đã huỷ nên bị từ chối, tiền vào sổ chưa gắn đơn.
      await webhook({
        id: Number(nextTx()),
        content: issued.qrUrl!.match(/ORD[0-9A-F]+/i)![0],
        transferAmount: 600,
      });
      const [late] = await ledger({ outcome: 'REJECTED' });
      expect(late).toBeDefined();
    });

    it('payOffline replacing an open QR on an untouched sale: FULL cash, QR cancelled by the caller', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await orders.payOffline(owner, tenantId, order.id, ownerId, {
        paymentMethod: PaymentMethod.CASH,
        customerPay: 1000,
      });
      const rows = await paymentsOf(order.id);
      expect(rows.map((p) => [p.method, p.status])).toEqual([
        ['SEPAY', 'CANCELLED'],
        ['CASH', 'PAID'],
      ]);
      expect(rows[0].cancelledById).toBe(ownerId);
      expect(rows[1].kind).toBe(PaymentKind.FULL);
      expect((await flowsOf(order.id)).map((f) => f.category)).toEqual([
        'ORDER_PAYMENT',
      ]);
    });

    it('overpayment: settles in full, records the excess on the ledger row and tells the owner', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 1500,
      });
      const done = await orderOf(order.id);
      expect(done.status).toBe(OrderStatus.COMPLETED);
      expect(done.paymentStatus).toBe(OrderPaymentStatus.PAID);
      const [qr] = await paymentsOf(order.id);
      expect(Number(qr.amount)).toBe(1500);
      expect(Number(qr.requestedAmount)).toBe(1000);
      const [row] = await ledger({ sepayTransactionId: txId });
      expect(Number(row.excessAmount)).toBe(500);
      const [paid] = await eventsOf(order.id, 'QR_PAID');
      expect(paid.metadata).toMatchObject({ overpaidBy: 500 });
      expect(noticesOf('ORDER_OVERPAID')).toHaveLength(1);
    });

    it('refund-excess hands back the overpayment: REFUND + ORDER_REFUND flow, status stays PAID, the ledger row is resolved only once nothing is left', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 1500,
      });
      const summary = async () =>
        (await reads.findOne(owner, tenantId, order.id)).paymentSummary;
      expect(await summary()).toMatchObject({
        received: 1500,
        refunded: 0,
        net: 1500,
        due: 0,
        overpaidBy: 500,
        pendingRemittance: 0,
      });

      // More than the excess is refused and writes nothing.
      await expect(
        excessRefunds.refundExcess(owner, tenantId, order.id, {
          amount: 600,
          method: 'BANK_TRANSFER',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID, max: 500 },
      });
      expect(await flowsOf(order.id)).toHaveLength(1);

      // A partial refund leaves the exception open.
      await excessRefunds.refundExcess(owner, tenantId, order.id, {
        amount: 200,
        method: 'BANK_TRANSFER',
      });
      expect(await summary()).toMatchObject({ overpaidBy: 300, refunded: 200 });
      expect(
        (await ledger({ sepayTransactionId: txId }))[0].resolvedAt,
      ).toBeNull();

      // The rest closes it.
      await excessRefunds.refundExcess(owner, tenantId, order.id, {
        amount: 300,
        method: 'BANK_TRANSFER',
        note: 'Trả lại khách',
      });
      expect(await summary()).toMatchObject({
        net: 1000,
        refunded: 500,
        overpaidBy: 0,
      });
      expect((await orderOf(order.id)).paymentStatus).toBe(
        OrderPaymentStatus.PAID,
      );
      const [row] = await ledger({ sepayTransactionId: txId });
      expect(row.resolvedAt).not.toBeNull();
      expect(row).toMatchObject({
        resolution: 'REFUNDED_MANUALLY',
        resolvedById: ownerId,
        resolutionNote: 'Trả lại khách',
      });

      const flows = await flowsOf(order.id);
      expect(flows.map((f) => [f.category, Number(f.amount), f.fund])).toEqual([
        ['ORDER_PAYMENT', 1500, 'BANK'],
        ['ORDER_REFUND', 200, 'BANK'],
        ['ORDER_REFUND', 300, 'BANK'],
      ]);
      const refunds = (await paymentsOf(order.id)).filter(
        (p) => p.kind === PaymentKind.REFUND,
      );
      expect(refunds.map((p) => p.createdById)).toEqual([ownerId, ownerId]);
      const events = await eventsOf(order.id, 'REFUNDED');
      expect(events).toHaveLength(2);
      expect(events[1].metadata).toMatchObject({
        amount: 300,
        method: 'BANK_TRANSFER',
        reason: 'EXCESS_PAYMENT',
        paymentId: refunds[1].id,
      });
      expect(events[1].actorId).toBe(ownerId);

      // Nothing is overpaid any more.
      await expect(
        excessRefunds.refundExcess(owner, tenantId, order.id, {
          amount: 1,
          method: 'CASH',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID },
      });
    });

    it('PATCH PENDING → COMPLETED is refused: no phantom income', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await expect(
        orders.updateStatus(owner, tenantId, order.id, OrderStatus.COMPLETED),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_USE_PAY_OFFLINE },
      });
      expect(await flowsOf(order.id)).toHaveLength(0);
      await orders.cancelPosSale(owner, tenantId, order.id, {});
    });
  });

  describe('trả hàng và huỷ đơn quầy', () => {
    it('returning a cash sale refunds exactly what the shop holds: REFUND payment + ORDER_REFUND flow, REFUNDED', async () => {
      const { order } = await posSale(PaymentMethod.CASH, {
        customerPay: 1500,
      });
      const returned = await orders.updateStatus(
        owner,
        tenantId,
        order.id,
        OrderStatus.RETURNED,
      );
      expect(returned.status).toBe(OrderStatus.RETURNED);
      expect(returned.paymentStatus).toBe(OrderPaymentStatus.REFUNDED);
      const rows = await paymentsOf(order.id);
      const refund = rows.find((p) => p.kind === PaymentKind.REFUND)!;
      expect(Number(refund.amount)).toBe(1000);
      expect(refund).toMatchObject({
        method: 'CASH',
        refundOfPaymentId: rows[0].id,
        createdById: ownerId,
      });
      const flows = await flowsOf(order.id);
      const out = flows.find((f) => f.category === 'ORDER_REFUND')!;
      expect(out).toMatchObject({
        paymentId: refund.id,
        createdById: ownerId,
        flowType: 'EXPENSE',
      });
      expect(Number(out.amount)).toBe(1000);
    });

    it('returning a QR-paid sale refunds by bank transfer, not through SePay', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await webhook({
        id: Number(nextTx()),
        content: order.paymentReference,
        transferAmount: 1000,
      });
      await orders.updateStatus(
        owner,
        tenantId,
        order.id,
        OrderStatus.RETURNED,
      );
      const refund = (await paymentsOf(order.id)).find(
        (p) => p.kind === PaymentKind.REFUND,
      )!;
      expect(refund.method).toBe(PaymentMethod.BANK_TRANSFER);
      expect((await flowsOf(order.id)).at(-1)).toMatchObject({
        category: 'ORDER_REFUND',
        fund: 'BANK',
      });
    });

    it('cancelling a sale that holds a partial transfer needs a refund amount, and books it', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      await webhook({
        id: Number(nextTx()),
        content: order.paymentReference,
        transferAmount: 400,
      });
      await expect(
        orders.cancelPosSale(owner, tenantId, order.id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED },
      });
      await expect(
        orders.updateStatus(owner, tenantId, order.id, OrderStatus.CANCELLED),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED },
      });
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PENDING);

      const cancelled = await orders.cancelPosSale(owner, tenantId, order.id, {
        refundAmount: 400,
      });
      expect(cancelled.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.paymentStatus).toBe(OrderPaymentStatus.REFUNDED);
      const refund = (await paymentsOf(order.id)).find(
        (p) => p.kind === PaymentKind.REFUND,
      )!;
      expect(Number(refund.amount)).toBe(400);
      expect(refund.method).toBe(PaymentMethod.BANK_TRANSFER);
      const [event] = await eventsOf(order.id, 'CANCELLED');
      expect(event.metadata).toMatchObject({
        refundAmount: 400,
        paymentId: refund.id,
      });
    });

    it('cancelling an unpaid sale cancels its waiting QR payment with the canceller recorded', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY, { user: cashier });
      await orders.cancelPosSale(cashier, tenantId, order.id, {});
      const [qr] = await paymentsOf(order.id);
      expect(qr.status).toBe(PaymentRecordStatus.CANCELLED);
      expect(qr.cancelledById).toBe(cashierId);
      // Tiền về sau khi huỷ: từ chối đúng lý do, vào sổ chưa gắn đơn.
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 1000,
      });
      expect((await ledger({ sepayTransactionId: txId }))[0]).toMatchObject({
        outcome: 'REJECTED',
        rejectReason: 'ORDER_CANCELLED',
      });
    });
  });

  // ───────────────────────── Phase 4: thu khi giao / tại quầy ─────────────────────────
  describe('chuyển thiếu khi giao', () => {
    it('short QR, then cash for the remainder, then the remittance: COMPLETED with 2 payments and 2 cash flows', async () => {
      const { orderId, shipmentId, reference } = await deliveredBy(
        DeliveryCollectionMethod.BANK_TRANSFER_QR,
      );
      await webhook({
        id: Number(nextTx()),
        content: reference,
        transferAmount: 600,
      });
      const afterQr = await orderOf(orderId);
      expect(afterQr.status).toBe(OrderStatus.RECEIVED);
      expect(afterQr.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
      expect(noticesOf('ORDER_PARTIAL_TRANSFER')).toHaveLength(1);

      // Shipper thu nốt 400 bằng tiền mặt: số tiền do server tính, không cần khoản QR còn mở.
      await delivery.payCash(driver, tenantId, shipmentId, {});
      const rows = await paymentsOf(orderId);
      expect(
        rows.map((p) => [
          p.method,
          p.status,
          Number(p.amount),
          p.remittanceStatus,
        ]),
      ).toEqual([
        ['SEPAY', 'PAID', 600, 'NOT_APPLICABLE'],
        ['CASH', 'PAID', 400, RemittanceStatus.PENDING],
      ]);
      const held = await orderOf(orderId);
      expect(held.status).toBe(OrderStatus.RECEIVED);
      expect(held.paymentStatus).toBe(OrderPaymentStatus.PAID);

      await remittances.confirm(owner, tenantId, orderId, { amount: 400 });
      const done = await orderOf(orderId);
      expect(done.status).toBe(OrderStatus.COMPLETED);
      expect(done.completedAt).not.toBeNull();
      const flows = await flowsOf(orderId);
      expect(
        flows.map((f) => [f.fund, f.paymentMethod, Number(f.amount)]),
      ).toEqual([
        ['BANK', 'SEPAY', 600],
        ['OWNER', 'CASH', 400],
      ]);
      expect(
        await prisma.invoice.count({ where: { orderId, status: 'ISSUED' } }),
      ).toBe(1);
    });

    it('short QR, then a new QR for exactly what is left (not the old amount) completes it', async () => {
      const { orderId, shipmentId, reference } = await deliveredBy(
        DeliveryCollectionMethod.BANK_TRANSFER_QR,
      );
      await webhook({
        id: Number(nextTx()),
        content: reference,
        transferAmount: 600,
      });
      // Khoản QR cũ đã PAID (chuyển thiếu): vẫn tạo được mã mới cho phần còn lại.
      const fresh = await delivery.reissueQr(driver, tenantId, shipmentId);
      expect(fresh.payment).toMatchObject({ amount: 400, status: 'PENDING' });
      expect(fresh.payment!.reference).not.toBe(reference);
      expect(fresh.order.amountDue).toBe(400);
      // Bấm lại khi mã còn sống đúng số: không đổi.
      const same = await delivery.reissueQr(driver, tenantId, shipmentId);
      expect(same.payment!.reference).toBe(fresh.payment!.reference);

      await webhook({
        id: Number(nextTx()),
        content: fresh.payment!.reference,
        transferAmount: 400,
      });
      const done = await orderOf(orderId);
      expect(done.status).toBe(OrderStatus.COMPLETED);
      expect(done.paymentStatus).toBe(OrderPaymentStatus.PAID);
      expect(await flowsOf(orderId)).toHaveLength(2);
    });

    it('refuses payCash / reissue when nothing is left to collect', async () => {
      const { shipmentId } = await deliveredBy(DeliveryCollectionMethod.CASH);
      await expect(
        delivery.payCash(driver, tenantId, shipmentId, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_COLLECTION_AMOUNT_MISMATCH },
      });
      await expect(
        delivery.reissueQr(driver, tenantId, shipmentId),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_QR_PAYMENT_NOT_PENDING },
      });
    });

    it('a short transfer on a pickup order keeps it PACKED: hand-over waits for the rest, then cash finishes it', async () => {
      const id = await packedPickup();
      const qr = await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.BANK_TRANSFER_QR,
      });
      await webhook({
        id: Number(nextTx()),
        content: qr.payment!.reference,
        transferAmount: 300,
      });
      const partial = await orderOf(id);
      expect(partial.status).toBe(OrderStatus.PACKED);
      expect(partial.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
      await expect(
        pickups.handOver(owner, tenantId, id, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_PICKUP_BALANCE_DUE },
      });
      await pickups.collect(owner, tenantId, id, {
        method: DeliveryCollectionMethod.CASH,
      });
      const rows = await paymentsOf(id);
      expect(rows.map((p) => [p.method, p.status, Number(p.amount)])).toEqual([
        ['SEPAY', 'PAID', 300],
        ['CASH', 'PAID', 700],
      ]);
      await pickups.handOver(owner, tenantId, id, {});
      expect((await orderOf(id)).status).toBe(OrderStatus.COMPLETED);
    });
  });

  describe('nộp tiền cho đơn đã RETURNED', () => {
    it('books the shipper cash (owner fund) and leaves the order RETURNED, event without a status move', async () => {
      const { orderId } = await deliveredBy(DeliveryCollectionMethod.CASH);
      // Giao xong rồi khách trả hàng khi tiền mặt còn ở tay shipper.
      await prisma.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.RETURNED },
      });
      await remittances.confirm(owner, tenantId, orderId, { amount: 1000 });
      const order = await orderOf(orderId);
      expect(order.status).toBe(OrderStatus.RETURNED);
      expect(order.completedAt).toBeNull();
      const [payment] = await paymentsOf(orderId);
      expect(payment.remittanceStatus).toBe(RemittanceStatus.RECEIVED);
      const [flow] = await flowsOf(orderId);
      expect(flow).toMatchObject({
        fund: 'OWNER',
        category: 'ORDER_PAYMENT',
        paymentId: payment.id,
      });
      const [event] = await eventsOf(orderId, 'REMITTANCE_CONFIRMED');
      expect(event.fromStatus).toBeNull();
      expect(event.toStatus).toBeNull();
      // Xác nhận lần hai: không còn khoản nào chờ nộp.
      await expect(
        remittances.confirm(owner, tenantId, orderId, { amount: 1000 }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REMITTANCE_NOT_PENDING },
      });
    });
  });

  // ───────────────────────── Phase 4: sổ SePay đủ mọi giao dịch ─────────────────────────
  describe('sổ giao dịch SePay', () => {
    it('no reference: recorded UNMATCHED / NO_REFERENCE, booked as an unallocated receipt, owner told, answered success', async () => {
      const txId = nextTx();
      const res = await webhook({
        id: Number(txId),
        content: 'chuyen tien linh tinh',
        transferAmount: 250_000,
      });
      expect(res.body.success).toBe(true);
      const [row] = await ledger({ sepayTransactionId: txId });
      expect(row).toMatchObject({
        outcome: 'UNMATCHED',
        rejectReason: 'NO_REFERENCE',
        orderId: null,
        paymentReference: null,
        accountNumber: ACCOUNT,
        content: 'chuyen tien linh tinh',
      });
      expect(Number(row.amount)).toBe(250_000);
      const flows = await prisma.cashFlow.findMany({
        where: { sepayLedgerId: row.id },
      });
      expect(flows).toHaveLength(1);
      expect(flows[0]).toMatchObject({
        category: 'UNALLOCATED_RECEIPT',
        flowType: 'INCOME',
        fund: 'BANK',
        orderId: null,
        paymentId: null,
        locationId: null,
        sepayTransactionId: txId,
      });
      expect(Number(flows[0].amount)).toBe(250_000);
      expect(noticesOf('ORDER_UNMATCHED_TRANSFER')).toHaveLength(1);
    });

    it('unknown reference: recorded UNMATCHED / UNKNOWN_REFERENCE with the reference kept', async () => {
      const txId = nextTx();
      const res = await webhook({
        id: Number(txId),
        content: 'ORD0000AAAA bàn ăn',
        transferAmount: 1000,
      });
      expect(res.body.success).toBe(true);
      expect((await ledger({ sepayTransactionId: txId }))[0]).toMatchObject({
        outcome: 'UNMATCHED',
        rejectReason: 'UNKNOWN_REFERENCE',
        paymentReference: 'ORD0000AAAA',
      });
    });

    it('a payload without any id is keyed by a hash: the same call twice is one row, one receipt', async () => {
      const payload = {
        content: 'khong co ma giao dich',
        transferAmount: 777,
        transactionDate: '2026-11-11 09:30:00',
      };
      const first = await webhook(payload);
      const second = await webhook(payload);
      expect(first.body.message).toBe('Unmatched transfer recorded');
      expect(second.body.message).toBe('Duplicate transaction');
      const rows = await ledger({ content: payload.content });
      expect(rows).toHaveLength(1);
      expect(rows[0].sepayTransactionId).toBeNull();
      expect(rows[0].dedupeKey).toMatch(/^h:/);
      expect(
        await prisma.cashFlow.count({ where: { sepayLedgerId: rows[0].id } }),
      ).toBe(1);

      // Có referenceCode của ngân hàng thì khoá là `ref:`.
      await webhook({
        ...payload,
        content: 'co ma ngan hang',
        referenceCode: 'FT777',
      });
      const [byRef] = await ledger({ content: 'co ma ngan hang' });
      expect(byRef.dedupeKey).toBe('ref:FT777');
      expect(byRef.bankReferenceCode).toBe('FT777');
    });

    it('the same transaction id twice at once settles once', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      const body = {
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 1000,
      };
      await Promise.all([webhook(body), webhook(body)]);
      expect(await ledger({ sepayTransactionId: txId })).toHaveLength(1);
      expect(
        (await flowsOf(order.id)).filter((f) => f.category === 'ORDER_PAYMENT'),
      ).toHaveLength(1);
      expect(
        (await paymentsOf(order.id)).filter((p) => p.status === 'PAID'),
      ).toHaveLength(1);
    });

    it('a transfer to an account no shop owns is recorded without a tenant and told to the operators, but only through the shared key', async () => {
      process.env.SEPAY_ORDER_WEBHOOK_API_KEY = SHARED_KEY;
      const txId = nextTx();
      const res = await webhook(
        { id: Number(txId), content: 'ORD123456', transferAmount: 5000 },
        SHARED_KEY,
        '0987999888',
      );
      expect(res.body.success).toBe(true);
      const row = await prisma.sepayTransaction.findFirstOrThrow({
        where: { tenantId: null, sepayTransactionId: txId },
      });
      expect(row).toMatchObject({
        outcome: 'UNMATCHED',
        rejectReason: 'UNKNOWN_TENANT',
        accountNumber: '0987999888',
      });
      expect(
        await prisma.cashFlow.count({ where: { sepayLedgerId: row.id } }),
      ).toBe(0);
      expect(notifySystem).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SYSTEM_SEPAY_UNMATCHED' }),
      );
      // Replay: không thêm dòng.
      await webhook(
        { id: Number(txId), content: 'ORD123456', transferAmount: 5000 },
        SHARED_KEY,
        '0987999888',
      );
      expect(
        await prisma.sepayTransaction.count({
          where: { tenantId: null, accountNumber: '0987999888' },
        }),
      ).toBe(1);

      // Key sai: không ghi gì, kẻ lạ không làm đầy sổ.
      const before = await prisma.sepayTransaction.count();
      const bad = await webhook(
        { id: 5_550_001, content: 'ORD123456', transferAmount: 5000 },
        'not-a-key',
        '0987999888',
      );
      expect(bad.body.success).toBe(false);
      expect(await prisma.sepayTransaction.count()).toBe(before);
      delete process.env.SEPAY_ORDER_WEBHOOK_API_KEY;
    });

    it('lists the exceptions and resolves each once; a refunded-by-hand receipt books the matching expense', async () => {
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: 'chuyen nham',
        transferAmount: 90_000,
      });
      const [row] = await ledger({ sepayTransactionId: txId });

      const listed = await sepayLedger.findAll(tenantId, {
        page: 1,
        limit: 100,
        unresolved: true,
      });
      const item = listed.data.find((r) => r.id === row.id)!;
      expect(item).toMatchObject({
        outcome: 'UNMATCHED',
        rejectReason: 'NO_REFERENCE',
        amount: 90_000,
        excessAmount: 0,
        order: null,
        resolvedAt: null,
        resolution: null,
        sepayTransactionId: txId,
        content: 'chuyen nham',
      });

      const resolved = await sepayLedger.resolve(owner, tenantId, row.id, {
        resolution: 'REFUNDED_MANUALLY',
        note: 'đã chuyển lại',
      });
      expect(resolved).toMatchObject({
        resolution: 'REFUNDED_MANUALLY',
        resolutionNote: 'đã chuyển lại',
      });
      expect(resolved.resolvedAt).not.toBeNull();
      expect(resolved.resolvedBy?.id).toBe(ownerId);
      const flows = await prisma.cashFlow.findMany({
        where: { sepayLedgerId: row.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        flows.map((f) => [f.category, f.flowType, Number(f.amount)]),
      ).toEqual([
        ['UNALLOCATED_RECEIPT', 'INCOME', 90_000],
        ['UNALLOCATED_REFUND', 'EXPENSE', 90_000],
      ]);
      expect(flows[1].createdById).toBe(ownerId);

      await expect(
        sepayLedger.resolve(owner, tenantId, row.id, { resolution: 'IGNORED' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SEPAY_TRANSACTION_ALREADY_RESOLVED },
      });
      const after = await sepayLedger.findAll(tenantId, {
        page: 1,
        limit: 100,
        unresolved: true,
      });
      expect(after.data.some((r) => r.id === row.id)).toBe(false);
      await expect(
        sepayLedger.resolve(owner, randomUUID(), row.id, {
          resolution: 'IGNORED',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SEPAY_TRANSACTION_NOT_FOUND },
      });
    });

    it('a settled row cannot be marked refunded here, and the failed attempt leaves it unresolved', async () => {
      const { order } = await posSale(PaymentMethod.SEPAY);
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: order.paymentReference,
        transferAmount: 1200,
      });
      const [row] = await ledger({ sepayTransactionId: txId });
      expect(Number(row.excessAmount)).toBe(200);
      await expect(
        sepayLedger.resolve(owner, tenantId, row.id, {
          resolution: 'REFUNDED_MANUALLY',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SEPAY_TRANSACTION_NOT_REFUNDABLE },
      });
      expect(
        (await ledger({ sepayTransactionId: txId }))[0].resolvedAt,
      ).toBeNull();
      // Dòng trả dư xuất hiện trong danh sách ngoại lệ; đối chiếu tay xong thì đánh dấu.
      const listed = await sepayLedger.findAll(tenantId, {
        page: 1,
        limit: 100,
        unresolved: true,
      });
      expect(listed.data.some((r) => r.id === row.id)).toBe(true);
      const done = await sepayLedger.resolve(owner, tenantId, row.id, {
        resolution: 'MATCHED_MANUALLY',
      });
      expect(done.resolution).toBe('MATCHED_MANUALLY');
    });

    it('a transfer to a reference the shipper replaced is rejected, booked as unallocated money, and the owner is told', async () => {
      const { orderId, shipmentId, reference } = await deliveredBy(
        DeliveryCollectionMethod.BANK_TRANSFER_QR,
      );
      await delivery.payCash(driver, tenantId, shipmentId, {});
      notify.mockClear();
      const txId = nextTx();
      await webhook({
        id: Number(txId),
        content: reference,
        transferAmount: 1000,
      });
      const [row] = await ledger({ sepayTransactionId: txId });
      expect(row).toMatchObject({
        outcome: 'REJECTED',
        rejectReason: 'PAYMENT_SUPERSEDED',
        orderId,
      });
      const [receipt] = await prisma.cashFlow.findMany({
        where: { sepayLedgerId: row.id },
      });
      expect(receipt).toMatchObject({
        category: 'UNALLOCATED_RECEIPT',
        orderId: null,
      });
      expect(Number(receipt.amount)).toBe(1000);
      expect(noticesOf('ORDER_LATE_TRANSFER')).toHaveLength(1);
      // Chưa thu xong nên đơn vẫn chờ chủ nhận tiền mặt.
      expect((await orderOf(orderId)).status).toBe(OrderStatus.RECEIVED);
    });
  });

  it('leaves the money ledger consistent', async () => {
    await assertMoneyInvariants(prisma, tenantId);
  });
});
