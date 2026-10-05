import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCancelService } from './../src/modules/orders/order-cancel.service';
import { SepayOrderService } from './../src/modules/orders/sepay-order.service';
import { CustomerService } from './../src/modules/customers/customers.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import {
  FulfillmentType,
  OrderItemStatus,
  OrderPaymentStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
import { FulfillmentStatus } from './../src/common/constants/fulfillment-status';
import { ShipmentStatus } from './../src/common/constants/shipment-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from './../src/common/constants/payment-method';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';
import type { CreateOrderDto } from './../src/modules/orders/dto/create-order.dto';

/**
 * Hủy đơn (A-5, OrderCancelService.cancel – `POST /orders/:id/cancel`) trên Postgres thật
 * (docker compose up -d): hủy trước / sau đóng gói (trả phần khoá về kệ), tiền cọc hoàn một phần /
 * giữ, các trạng thái không được hủy, và YCSX liên quan chỉ được báo lại. Tự tạo tenant riêng và
 * dọn sạch, chạy lại bao nhiêu lần cũng được.
 */
describe('POST /orders/:id/cancel – OrderCancelService.cancel', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let cancels: OrderCancelService;
  let fulfillments: FulfillmentService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const customerId = randomUUID();
  const workshopId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  const createOrder = async (over: Partial<CreateOrderDto> = {}) =>
    (
      await manual.create(owner, tenantId, {
        branchId,
        customerId,
        assigneeId: ownerId,
        fulfillmentType: 'HOME_DELIVERY',
        items: [{ productItemId: sofaId, quantity: 2 }],
        ...over,
      })
    ).id;

  const sofaStock = () =>
    prisma.inventory.findFirstOrThrow({
      where: { tenantId, locationId: warehouseId, productItemId: sofaId },
    });

  const cancel = (id: string, body = {}) =>
    cancels.cancel(owner, tenantId, id, body);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        OrderService,
        OrderPricingService,
        ManualOrderService,
        OrderCancelService,
        CustomerService,
        InventoryService,
        FulfillmentService,
        {
          provide: NotificationService,
          useValue: {
            managersOfLocation: () => Promise.resolve([]),
            notify: jest.fn(),
          },
        },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
        { provide: PromotionService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    manual = moduleRef.get(ManualOrderService);
    cancels = moduleRef.get(OrderCancelService);
    fulfillments = moduleRef.get(FulfillmentService);
    const inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'cancel-e2e' } });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `cancel-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho', type: 'WAREHOUSE' },
    });
    await prisma.location.create({
      data: {
        id: branchId,
        tenantId,
        name: 'CN',
        type: 'BRANCH',
        defaultFulfillmentLocationId: warehouseId,
      },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.warehouse.create({
      data: { id: warehouseId, tenantId, locationId: warehouseId },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: sofaId,
        tenantId,
        productId,
        productName: 'Sofa',
        productCode: `CANCEL-${sofaId}`,
        sku: `CANCEL-${sofaId.slice(0, 8)}`,
        retailPrice: 10_000_000,
        costPrice: 0,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    await prisma.supplier.create({
      data: {
        id: workshopId,
        tenantId,
        supplierName: 'Xưởng',
        type: 'WORKSHOP',
      },
    });
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: sofaId,
        quantity: 10,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'cancel-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.productionRequestItem.deleteMany({
      where: { productionRequest: { tenantId } },
    });
    await prisma.productionRequest.deleteMany({ where: { tenantId } });
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({
      where: { tenantId, refundOfPaymentId: { not: null } },
    });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.warehouse.deleteMany({ where: { tenantId } });
    await prisma.location.updateMany({
      where: { tenantId },
      data: { defaultFulfillmentLocationId: null },
    });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('cancels a CONFIRMED order, recording who, when and why', async () => {
    const id = await createOrder();
    const result = await cancel(id, { reason: 'Khách đổi ý' });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: true, payments: true },
    });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.cancelledById).toBe(ownerId);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.cancelReason).toBe('Khách đổi ý');
    expect(row.items.every((i) => i.status === OrderItemStatus.CANCELLED)).toBe(
      true,
    );
    expect(row.payments).toHaveLength(0);
    expect(result.refund).toBeNull();
    expect(result.openProductionRequests).toEqual([]);
  });

  it('gives a packed order its locked goods back and cancels the fulfillment and the open shipment', async () => {
    const id = await createOrder();
    const fulfillment = await fulfillments.packOrder(owner, id, {});
    expect((await sofaStock()).lockedStock).toBe(2);
    // POST /shipments (C-2) is not built yet - stand in for "the carrier picked it up".
    await prisma.order.update({
      where: { id },
      data: { status: OrderStatus.PICKED_UP },
    });
    const shipment = await prisma.shipment.create({
      data: {
        tenantId,
        orderId: id,
        fulfillmentId: fulfillment.id,
        status: ShipmentStatus.PICKED_UP,
      },
    });

    await cancel(id);

    const stock = await sofaStock();
    expect(stock.lockedStock).toBe(0);
    expect(stock.stock).toBe(10);
    expect(
      (
        await prisma.fulfillment.findUniqueOrThrow({
          where: { id: fulfillment.id },
        })
      ).status,
    ).toBe(FulfillmentStatus.CANCELLED);
    expect(
      (await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } }))
        .status,
    ).toBe(ShipmentStatus.CANCELLED);
    // Releasing a lock moves nothing, so the ledger has no new row.
    expect(
      await prisma.inventoryTransaction.count({
        where: { tenantId, referenceId: id },
      }),
    ).toBe(0);
  });

  it('refunds part of a deposit as a REFUND payment and keeps the rest', async () => {
    const id = await createOrder({
      deposit: { type: 'AMOUNT', value: 3_000_000, method: 'CASH' },
    });
    const result = await cancel(id, {
      refundAmount: 1_000_000,
      refundMethod: 'BANK_TRANSFER',
    });
    expect(result.refund).toEqual({
      held: 3_000_000,
      refunded: 1_000_000,
      kept: 2_000_000,
    });

    const row = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: { payments: true },
    });
    expect(row.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_REFUNDED);
    const deposit = row.payments.find((p) => p.kind === PaymentKind.DEPOSIT)!;
    const refund = row.payments.find((p) => p.kind === PaymentKind.REFUND)!;
    expect(refund).toMatchObject({
      status: PaymentRecordStatus.PAID,
      method: 'BANK_TRANSFER',
      refundOfPaymentId: deposit.id,
    });
    expect(Number(refund.amount)).toBe(1_000_000);
  });

  it('keeps the whole deposit when the refund is 0, writing no refund', async () => {
    const id = await createOrder({
      deposit: { type: 'PERCENT', value: 10, method: 'CASH' },
    });
    await cancel(id, { refundAmount: 0 });
    const row = await prisma.order.findUniqueOrThrow({
      where: { id },
      include: { payments: true },
    });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.payments.map((p) => p.kind)).toEqual([PaymentKind.DEPOSIT]);
  });

  it.each([
    [undefined, ErrorCode.ORDER_REFUND_AMOUNT_REQUIRED],
    [5_000_001, ErrorCode.ORDER_REFUND_EXCEEDS_DEPOSIT],
  ])(
    'refuses refund %s on a 5.000.000 deposit with %s, changing nothing',
    async (refundAmount, code) => {
      const id = await createOrder({
        deposit: { type: 'AMOUNT', value: 5_000_000, method: 'CASH' },
      });
      await expect(cancel(id, { refundAmount })).rejects.toMatchObject({
        response: { code },
      });
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id } })).status,
      ).toBe(OrderStatus.CONFIRMED);
    },
  );

  it.each([OrderStatus.SHIPPING, OrderStatus.COMPLETED, OrderStatus.CANCELLED])(
    'refuses to cancel an order in %s',
    async (status) => {
      const id = await createOrder();
      await prisma.order.update({ where: { id }, data: { status } });
      await expect(cancel(id)).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_CANCEL_NOT_ALLOWED },
      });
    },
  );

  it('leaves a counter sale to the till', async () => {
    const id = await createOrder();
    await prisma.order.update({
      where: { id },
      data: { fulfillmentType: FulfillmentType.TAKEAWAY },
    });
    await expect(cancel(id)).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_CANCEL_NOT_ALLOWED },
    });
  });

  it('lists the open production requests for its lines without touching them', async () => {
    const id = await createOrder();
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });
    const request = await prisma.productionRequest.create({
      data: {
        tenantId,
        code: `YCSX-${id.slice(0, 8)}`,
        supplierId: workshopId,
        locationId: warehouseId,
        status: 'SENT',
        items: {
          create: {
            productItemId: sofaId,
            orderItemId: line.id,
            quantity: 2,
          },
        },
      },
    });

    const result = await cancel(id);

    expect(result.openProductionRequests).toHaveLength(1);
    expect(result.openProductionRequests[0]).toMatchObject({
      orderItemId: line.id,
      quantity: 2,
      productionRequest: { id: request.id, status: 'SENT' },
    });
    expect(
      (
        await prisma.productionRequest.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).status,
    ).toBe('SENT');
  });
});
