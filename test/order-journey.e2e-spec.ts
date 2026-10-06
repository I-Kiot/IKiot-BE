import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AllExceptionsFilter } from './../src/common/filters/all-exceptions.filter';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * F-1: the whole order journey over HTTP, against the real app and Postgres (docker compose up -d).
 * One shop, one sofa nobody has in stock, followed from the order to the buy-again order:
 *
 *   manual order (deposit) → short on the production list → production request → sent →
 *   workshop delivery with a defect → packed → picked up → shipping (stock leaves) → delivered,
 *   cash collected → owner confirms the cash → completed → customer returns a damaged piece →
 *   inspected into the damaged-goods warehouse → buy-again order linked to the return.
 *
 * Each step asserts what the screens read (status, stock check, production list) and what the
 * ledger must show (stock, locked stock, the damaged-goods warehouse). The tests run in order and
 * share state; the suite creates its own tenant and deletes it.
 */
jest.setTimeout(120_000);

const RUN = Date.now().toString().slice(-7);
const PHONE_OWNER = `090${RUN}`;
const TENANT_NAME = `Journey ${RUN}`;
const SOFA_PRICE = 10_000_000;

describe('F-1 order journey, end to end over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let http: () => request.Agent;

  let token = '';
  let ownerId = '';
  let tenantId = '';
  let branchId = '';
  let warehouseId = '';
  let damagedId = '';
  let workshopId = '';
  let sofaId = '';
  let customerId = '';
  let orderId = '';
  let lineId = '';
  let requestId = '';
  let shipmentId = '';
  let returnId = '';

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const order = async () =>
    (await http().get(`/orders/${orderId}`).set(auth()).expect(200)).body.data;
  const stockAt = async (locationId: string) =>
    prisma.inventory.findFirst({
      where: { tenantId, locationId, productItemId: sofaId },
      select: { stock: true, lockedStock: true },
    });
  const shortRow = async () => {
    const list = await http()
      .get('/production-list')
      .query({ locationId: warehouseId, productItemId: sofaId })
      .set(auth())
      .expect(200);
    return list.body.data[0] as {
      shortQuantity: number;
      onOrderQuantity: number;
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    http = () => request(app.getHttpServer());
  });

  afterAll(async () => {
    if (tenantId) await cleanup(tenantId);
    await app?.close();
  });

  async function cleanup(t: string) {
    await prisma.orderReturnItem.deleteMany({
      where: { orderReturn: { tenantId: t } },
    });
    await prisma.orderReturn.updateMany({
      where: { tenantId: t },
      data: { replacementOrderId: null },
    });
    await prisma.orderReturn.deleteMany({ where: { tenantId: t } });
    await prisma.shipmentEvent.deleteMany({
      where: { shipment: { tenantId: t } },
    });
    await prisma.shipment.deleteMany({ where: { tenantId: t } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId: t } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId: t } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId: t } });
    await prisma.payment.deleteMany({
      where: { tenantId: t, refundOfPaymentId: { not: null } },
    });
    await prisma.payment.deleteMany({ where: { tenantId: t } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId: t } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId: t } });
    await prisma.stockMovementRequestItem.deleteMany({
      where: { request: { tenantId: t } },
    });
    await prisma.stockMovementRequest.deleteMany({ where: { tenantId: t } });
    await prisma.productionRequestItem.deleteMany({
      where: { productionRequest: { tenantId: t } },
    });
    await prisma.productionRequest.deleteMany({ where: { tenantId: t } });
    await prisma.orderItem.deleteMany({
      where: { order: { tenantId: t }, parentItemId: { not: null } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId: t } } });
    await prisma.cashFlow.deleteMany({ where: { tenantId: t } });
    await prisma.order.deleteMany({ where: { tenantId: t } });
    await prisma.inventory.deleteMany({ where: { tenantId: t } });
    await prisma.customer.deleteMany({ where: { tenantId: t } });
    await prisma.productItemSupplier.deleteMany({
      where: { productItem: { tenantId: t } },
    });
    await prisma.productItemDetail.deleteMany({
      where: { productItem: { tenantId: t } },
    });
    await prisma.productItem.deleteMany({ where: { tenantId: t } });
    await prisma.product.deleteMany({ where: { tenantId: t } });
    await prisma.supplier.deleteMany({ where: { tenantId: t } });
    await prisma.notification.deleteMany({ where: { tenantId: t } });
    await prisma.auditLog.deleteMany({ where: { tenantId: t } });
    await prisma.subscriptionHistoryLog.deleteMany({
      where: { subscription: { tenantId: t } },
    });
    await prisma.subscriptionInvoice.deleteMany({ where: { tenantId: t } });
    await prisma.subscription.deleteMany({ where: { tenantId: t } });
    await prisma.location.updateMany({
      where: { tenantId: t },
      data: {
        managerId: null,
        damagedLocationId: null,
        defaultFulfillmentLocationId: null,
      },
    });
    await prisma.user.updateMany({
      where: { tenantId: t },
      data: { roleId: null, locationId: null },
    });
    await prisma.user.deleteMany({ where: { tenantId: t } });
    await prisma.location.deleteMany({ where: { tenantId: t } });
    await prisma.tenant.deleteMany({ where: { id: t } });
  }

  it('sets up a shop: branch, warehouse with a damaged-goods warehouse, a workshop, a sofa, a customer', async () => {
    const registered = await http()
      .post('/auth/register')
      .send({
        tenantName: TENANT_NAME,
        phoneNumber: PHONE_OWNER,
        password: 'password123',
        otpCode: 'DEV_BYPASS',
      })
      .expect(201);
    token = registered.body.data.accessToken;
    tenantId = registered.body.data.user.tenantId;
    ownerId = registered.body.data.user.id;
    await http()
      .post('/subscription/free-trial')
      .set(auth())
      .send()
      .expect(201);
    // The trial allows one warehouse; the journey needs a damaged-goods warehouse beside the main one.
    await prisma.subscription.updateMany({
      where: { tenantId },
      data: { quotaSnapshotMaxWarehouses: 5 },
    });

    branchId = (
      await http()
        .post('/branches')
        .set(auth())
        .send({ name: 'CN Quận 1', phoneNumber: [`091${RUN}`] })
        .expect(201)
    ).body.data.id;
    damagedId = (
      await http()
        .post('/warehouses')
        .set(auth())
        .send({
          name: 'Kho hàng hỏng',
          phoneNumber: [`092${RUN}`],
          isSellable: false,
        })
        .expect(201)
    ).body.data.id;
    warehouseId = (
      await http()
        .post('/warehouses')
        .set(auth())
        .send({
          name: 'Kho tổng',
          phoneNumber: [`093${RUN}`],
          damagedLocationId: damagedId,
        })
        .expect(201)
    ).body.data.id;
    workshopId = (
      await http()
        .post('/suppliers')
        .set(auth())
        .send({
          supplierName: 'Xưởng Mộc An',
          type: 'WORKSHOP',
          creditLimit: 100_000_000,
        })
        .expect(201)
    ).body.data.id;
    const product = await http()
      .post('/products')
      .set(auth())
      .send({
        name: 'Sofa băng',
        items: [
          {
            productName: 'Sofa băng 1m8',
            productCode: `SOFA-${RUN}`,
            sku: `SOFA-${RUN}`,
            retailPrice: SOFA_PRICE,
            costPrice: 6_000_000,
          },
        ],
      })
      .expect(201);
    sofaId = product.body.data.items[0].id;
    customerId = (
      await http()
        .post('/customers')
        .set(auth())
        .send({ name: 'Chị Lan', phone: `094${RUN}` })
        .expect(201)
    ).body.data.id;
  });

  it('takes a manual order with a deposit; nothing in stock, nothing held', async () => {
    const created = await http()
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        customerId,
        assigneeId: ownerId,
        fulfillmentType: 'HOME_DELIVERY',
        priority: 'HIGH',
        items: [
          { productItemId: sofaId, quantity: 2, sourceLocationId: warehouseId },
        ],
        deposit: { type: 'AMOUNT', value: 6_000_000, method: 'CASH' },
        recipientName: 'Chị Lan',
        recipientPhone: `094${RUN}`,
        deliveryAddress: '12 Lê Lợi, Q1',
      })
      .expect(201);
    orderId = created.body.data.id;

    const detail = await order();
    lineId = detail.items[0].id;
    expect(detail.status).toBe('CONFIRMED');
    expect(detail.grandTotal).toBe(2 * SOFA_PRICE);
    expect(detail.amountDue).toBe(2 * SOFA_PRICE - 6_000_000);
    expect(detail.items[0].stockCheck).toMatchObject({
      status: 'OUT',
      shortQuantity: 2,
    });

    const journey = await http()
      .get('/orders')
      .query({ excludePos: true })
      .set(auth())
      .expect(200);
    expect(journey.body.data.map((o: { id: string }) => o.id)).toContain(
      orderId,
    );
  });

  it('cannot pack what is not on the shelf', async () => {
    const refused = await http()
      .post(`/orders/${orderId}/pack`)
      .set(auth())
      .send({})
      .expect(400);
    expect(refused.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('shows the sofa as short on the production list, and raises a production request for it', async () => {
    expect(await shortRow()).toMatchObject({
      shortQuantity: 2,
      onOrderQuantity: 0,
    });

    const created = await http()
      .post('/production-requests')
      .set(auth())
      .send({
        supplierId: workshopId,
        locationId: warehouseId,
        items: [{ productItemId: sofaId, quantity: 3, orderItemId: lineId }],
      })
      .expect(201);
    requestId = created.body.data.id;
    expect(created.body.data.status).toBe('DRAFT');

    const sent = await http()
      .patch(`/production-requests/${requestId}/status`)
      .set(auth())
      .send({ status: 'SENT' })
      .expect(200);
    expect(sent.body.data.status).toBe('SENT');
    expect(await shortRow()).toMatchObject({
      shortQuantity: 0,
      onOrderQuantity: 3,
    });
  });

  it('receives the workshop delivery: good pieces on the shelf, the defect in the damaged-goods warehouse', async () => {
    const requestLine = (
      await http()
        .get(`/production-requests/${requestId}`)
        .set(auth())
        .expect(200)
    ).body.data.items[0];
    const received = await http()
      .post(`/production-requests/${requestId}/receive`)
      .set(auth())
      .send({
        items: [
          {
            productionRequestItemId: requestLine.id,
            receivedQuantity: 3,
            defectQuantity: 1,
            unitCost: 5_500_000,
          },
        ],
      })
      .expect(201);
    expect(received.body.data.status).toBe('COMPLETED');
    expect(received.body.data.receipts).toHaveLength(1);

    expect(await stockAt(warehouseId)).toEqual({ stock: 2, lockedStock: 0 });
    expect((await stockAt(damagedId))?.stock).toBe(1);
    expect((await order()).items[0].stockCheck.status).toBe('ENOUGH');
  });

  it('packs the order, locking the goods without moving stock', async () => {
    await http()
      .post(`/orders/${orderId}/pack`)
      .set(auth())
      .send({})
      .expect(200);
    expect((await order()).status).toBe('PACKED');
    expect(await stockAt(warehouseId)).toEqual({ stock: 2, lockedStock: 2 });
  });

  it('hands it to our own shipper, then ships it - stock leaves here', async () => {
    const shipment = await http()
      .post('/shipments')
      .set(auth())
      .send({ orderId, carrierType: 'INTERNAL', driverId: ownerId })
      .expect(201);
    shipmentId = shipment.body.data.id;
    expect((await order()).status).toBe('PICKED_UP');

    await http()
      .post(`/orders/${orderId}/ship`)
      .set(auth())
      .send({})
      .expect(200);
    expect((await order()).status).toBe('SHIPPING');
    expect(await stockAt(warehouseId)).toEqual({ stock: 0, lockedStock: 0 });
  });

  it('is delivered and the shipper collects the rest in cash; the owner confirms all of it', async () => {
    const due = (await order()).amountDue;
    await http()
      .post(`/shipments/${shipmentId}/deliver`)
      .set(auth())
      .send({
        proofPhotoUrls: ['https://cdn.example.com/giao.jpg'],
        paymentMethod: 'CASH',
        collectedAmount: due,
      })
      .expect(200);
    const received = await order();
    expect(received.status).toBe('RECEIVED');
    expect(received.collection).toMatchObject({
      method: 'CASH',
      amount: due,
      cashRemittanceStatus: 'PENDING',
    });

    const short = await http()
      .post(`/orders/${orderId}/confirm-remittance`)
      .set(auth())
      .send({ amount: due - 100_000 })
      .expect(400);
    expect(short.body.code).toBe('ORDER_REMITTANCE_AMOUNT_MISMATCH');

    await http()
      .post(`/orders/${orderId}/confirm-remittance`)
      .set(auth())
      .send({ amount: due })
      .expect(200);
    const completed = await order();
    expect(completed.status).toBe('COMPLETED');
    expect(completed.collection.cashRemittanceStatus).toBe('RECEIVED');
  });

  it('takes back a damaged piece into the damaged-goods warehouse', async () => {
    const created = await http()
      .post('/order-returns')
      .set(auth())
      .send({
        orderId,
        reason: 'CUSTOMER_RETURN',
        items: [{ orderItemId: lineId, quantity: 1 }],
      })
      .expect(201);
    returnId = created.body.data.id;
    await http()
      .post(`/order-returns/${returnId}/receive`)
      .set(auth())
      .send({})
      .expect(200);
    const inspected = await http()
      .post(`/order-returns/${returnId}/inspect`)
      .set(auth())
      .send({ items: [{ orderItemId: lineId, condition: 'DAMAGED' }] })
      .expect(200);
    expect(inspected.body.data.status).toBe('COMPLETED');

    expect((await stockAt(damagedId))?.stock).toBe(2);
    expect(await stockAt(warehouseId)).toEqual({ stock: 0, lockedStock: 0 });
    // Partly returned: the order stays completed.
    expect((await order()).status).toBe('COMPLETED');
  });

  it('sells the customer a new sofa and links it to the return as its buy-again order', async () => {
    const again = await http()
      .post('/orders')
      .set(auth())
      .send({
        branchId,
        customerId,
        assigneeId: ownerId,
        fulfillmentType: 'HOME_DELIVERY',
        items: [
          { productItemId: sofaId, quantity: 1, sourceLocationId: warehouseId },
        ],
      })
      .expect(201);
    const linked = await http()
      .patch(`/order-returns/${returnId}/replacement-order`)
      .set(auth())
      .send({ orderId: again.body.data.id })
      .expect(200);
    expect(linked.body.data.replacementOrder).toMatchObject({
      id: again.body.data.id,
    });
    // The new sofa is short again, so it is back on the production list.
    expect((await shortRow()).shortQuantity).toBe(1);
  });
});
