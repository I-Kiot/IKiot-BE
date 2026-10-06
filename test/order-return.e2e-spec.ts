import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCustomizationService } from './../src/modules/orders/order-customization.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { OrderReturnService } from './../src/modules/order-returns/order-returns.service';
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
  OrderItemStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
import {
  OrderReturnReason,
  OrderReturnStatus,
  ReturnCondition,
} from './../src/common/constants/return-status';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Hoàn hàng (D-5, OrderReturnService) trên Postgres thật: tạo đơn hoàn → nhận hàng → kiểm từng
 * dòng. GOOD cộng lại tồn bán được, DAMAGED vào kho hàng hỏng của kho xuất; vượt số lượng, đơn
 * chưa trừ kho, người không có quyền đều bị chặn. `ship` (C-2) chưa có route nên test tự trừ tồn
 * bằng `shipLockedStock` đúng như C-2 sẽ làm. Tự tạo tenant riêng và dọn sạch.
 */
describe('/order-returns – OrderReturnService', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let returns: OrderReturnService;
  let fulfillments: FulfillmentService;
  let inventory: InventoryService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const damagedId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const customerId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;
  const staff = {
    userId: staffId,
    tenantId,
    systemRole: SystemRole.STAFF,
    permissions: new Set<string>(['orders:view_all']),
    branchId,
    warehouseId: null,
  } as unknown as AuthUser;

  const stockAt = async (locationId: string) =>
    (
      await prisma.inventory.findFirst({
        where: { tenantId, locationId, productItemId: sofaId },
      })
    )?.stock ?? 0;

  /** A shipped order: packed, then deducted the way `ship` will (SALE ledger with the order line). */
  const shippedOrder = async (quantity = 2, assigneeId = ownerId) => {
    const created = await manual.create(owner, tenantId, {
      branchId,
      customerId,
      assigneeId,
      fulfillmentType: 'HOME_DELIVERY',
      items: [{ productItemId: sofaId, quantity }],
    });
    await fulfillments.packOrder(owner, created.id, {});
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: created.id },
    });
    await prisma.$transaction(async (tx) => {
      await inventory.shipLockedStock(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: sofaId,
        quantity,
        label: 'Sofa',
        ledger: {
          type: InventoryTxType.SALE,
          referenceType: InventoryRefType.ORDER,
          referenceId: created.id,
          orderItemId: line.id,
          createdById: ownerId,
        },
      });
      await tx.orderItem.update({
        where: { id: line.id },
        data: { status: OrderItemStatus.SHIPPED },
      });
      await tx.order.update({
        where: { id: created.id },
        data: { status: OrderStatus.SHIPPING },
      });
    });
    return { orderId: created.id, lineId: line.id };
  };

  const open = (
    orderId: string,
    lineId: string,
    quantity: number,
    as: AuthUser = owner,
  ) =>
    returns.create(as, tenantId, {
      orderId,
      reason: OrderReturnReason.CUSTOMER_RETURN,
      items: [{ orderItemId: lineId, quantity }],
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        OrderService,
        OrderPricingService,
        ManualOrderService,
        OrderCustomizationService,
        OrderReadService,
        OrderReturnService,
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
    returns = moduleRef.get(OrderReturnService);
    fulfillments = moduleRef.get(FulfillmentService);
    inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'return-e2e' } });
    for (const id of [ownerId, staffId]) {
      await prisma.user.create({
        data: {
          id,
          tenantId,
          phoneNumber: `return-${id}`,
          systemRole:
            id === ownerId ? SystemRole.TENANT_OWNER : SystemRole.STAFF,
          status: UserStatus.ACTIVE,
        },
      });
    }
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
        id: warehouseId,
        tenantId,
        name: 'Kho',
        type: 'WAREHOUSE',
        damagedLocationId: damagedId,
      },
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
    for (const id of [warehouseId, damagedId]) {
      await prisma.warehouse.create({
        data: { id, tenantId, locationId: id },
      });
    }
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    await prisma.productItem.create({
      data: {
        id: sofaId,
        tenantId,
        productId,
        productName: 'Sofa',
        productCode: `RET-${sofaId}`,
        sku: `RET-${sofaId.slice(0, 8)}`,
        retailPrice: 10_000_000,
        costPrice: 0,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: sofaId,
        quantity: 20,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'return-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.orderReturnItem.deleteMany({
      where: { orderReturn: { tenantId } },
    });
    await prisma.orderReturn.deleteMany({ where: { tenantId } });
    await prisma.shipment.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.warehouse.deleteMany({ where: { tenantId } });
    await prisma.location.updateMany({
      where: { tenantId },
      data: { defaultFulfillmentLocationId: null, damagedLocationId: null },
    });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('takes a whole order back: REQUESTED → INSPECTING → COMPLETED, stock up, order RETURNED', async () => {
    const before = await stockAt(warehouseId);
    const { orderId, lineId } = await shippedOrder(2);
    expect(await stockAt(warehouseId)).toBe(before - 2);

    const created = await open(orderId, lineId, 2);
    expect(created.status).toBe(OrderReturnStatus.REQUESTED);
    expect(created.code).toMatch(/^DH-HOAN-/);
    expect(await stockAt(warehouseId)).toBe(before - 2); // nothing moves yet

    const received = await returns.receive(owner, tenantId, created.id);
    expect(received.status).toBe(OrderReturnStatus.INSPECTING);
    expect(received.receivedBy?.id).toBe(ownerId);

    const done = await returns.inspect(owner, tenantId, created.id, {
      items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
    });
    expect(done.status).toBe(OrderReturnStatus.COMPLETED);
    expect(done.items[0]).toMatchObject({
      condition: ReturnCondition.GOOD,
      location: { id: warehouseId },
    });
    expect(await stockAt(warehouseId)).toBe(before);

    const line = await prisma.orderItem.findUniqueOrThrow({
      where: { id: lineId },
    });
    expect(line.returnedQuantity).toBe(2);
    expect(line.status).toBe(OrderItemStatus.RETURNED);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
    ).toBe(OrderStatus.RETURNED);
    expect(
      await prisma.inventoryTransaction.count({
        where: {
          tenantId,
          referenceId: created.id,
          type: InventoryTxType.RETURN_GOOD,
        },
      }),
    ).toBeGreaterThan(0);
  });

  it('sends damaged goods to the damaged-goods warehouse and leaves the order un-RETURNED on a partial return', async () => {
    const before = await stockAt(warehouseId);
    const { orderId, lineId } = await shippedOrder(3);
    const created = await open(orderId, lineId, 1);
    await returns.receive(owner, tenantId, created.id);
    await returns.inspect(owner, tenantId, created.id, {
      items: [{ orderItemId: lineId, condition: ReturnCondition.DAMAGED }],
    });

    expect(await stockAt(warehouseId)).toBe(before - 3); // not sellable stock
    expect(await stockAt(damagedId)).toBe(1);
    const row = await prisma.orderReturnItem.findFirstOrThrow({
      where: { returnId: created.id },
    });
    expect(row.locationId).toBe(damagedId);
    expect(
      await prisma.inventoryTransaction.count({
        where: {
          tenantId,
          referenceId: created.id,
          type: InventoryTxType.RETURN_DAMAGED,
        },
      }),
    ).toBeGreaterThan(0);
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });
    expect(order.status).toBe(OrderStatus.SHIPPING);
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } }))
        .returnedQuantity,
    ).toBe(1);
  });

  it('refuses to inspect a line without a condition, and a DAMAGED line when no damaged-goods warehouse is set', async () => {
    const { orderId, lineId } = await shippedOrder(1);
    const created = await open(orderId, lineId, 1);
    await returns.receive(owner, tenantId, created.id);
    await expect(
      returns.inspect(owner, tenantId, created.id, {
        items: [{ orderItemId: lineId }],
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_CONDITION_REQUIRED },
    });

    await prisma.location.update({
      where: { id: warehouseId },
      data: { damagedLocationId: null },
    });
    try {
      await expect(
        returns.inspect(owner, tenantId, created.id, {
          items: [{ orderItemId: lineId, condition: ReturnCondition.DAMAGED }],
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.LOCATION_DAMAGED_REQUIRED },
      });
    } finally {
      await prisma.location.update({
        where: { id: warehouseId },
        data: { damagedLocationId: damagedId },
      });
    }
    // The transaction rolled back: still waiting to be inspected, nothing returned.
    expect(
      (
        await prisma.orderReturn.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).status,
    ).toBe(OrderReturnStatus.INSPECTING);
    expect(
      (await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } }))
        .returnedQuantity,
    ).toBe(0);
  });

  it('refuses a GOOD return into a damaged-goods location', async () => {
    const { orderId, lineId } = await shippedOrder(1);
    const created = await open(orderId, lineId, 1);
    await returns.receive(owner, tenantId, created.id);
    await expect(
      returns.inspect(owner, tenantId, created.id, {
        items: [
          {
            orderItemId: lineId,
            condition: ReturnCondition.GOOD,
            locationId: damagedId,
          },
        ],
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_NOT_SELLABLE },
    });
  });

  it('refuses an order whose goods have not left stock, and more than was sold', async () => {
    const confirmed = await manual.create(owner, tenantId, {
      branchId,
      customerId,
      assigneeId: ownerId,
      fulfillmentType: 'HOME_DELIVERY',
      items: [{ productItemId: sofaId, quantity: 1 }],
    });
    const confirmedLine = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: confirmed.id },
    });
    await expect(open(confirmed.id, confirmedLine.id, 1)).rejects.toMatchObject(
      { response: { code: ErrorCode.ORDER_RETURN_ORDER_NOT_RETURNABLE } },
    );

    const { orderId, lineId } = await shippedOrder(2);
    await expect(open(orderId, lineId, 3)).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_QTY_EXCEEDS },
    });
    // An open return speaks for its quantity: 2 of 2 are taken, so even 1 more is too many.
    await open(orderId, lineId, 2);
    await expect(open(orderId, lineId, 1)).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_QTY_EXCEEDS },
    });
  });

  it('lets the person in charge open a return without returns:create, but nobody else', async () => {
    const { orderId, lineId } = await shippedOrder(1, staffId);
    const created = await open(orderId, lineId, 1, staff);
    expect(created.createdBy?.id).toBe(staffId);

    const other = await shippedOrder(1, ownerId);
    await expect(
      open(other.orderId, other.lineId, 1, staff),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_DENIED },
    });
  });

  it('cancels an open return, and refuses to receive, inspect or cancel it twice', async () => {
    const { orderId, lineId } = await shippedOrder(1);
    const created = await open(orderId, lineId, 1);
    const cancelled = await returns.cancel(owner, tenantId, created.id);
    expect(cancelled.status).toBe(OrderReturnStatus.CANCELLED);
    for (const call of [
      () => returns.receive(owner, tenantId, created.id),
      () =>
        returns.inspect(owner, tenantId, created.id, {
          items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
        }),
      () => returns.cancel(owner, tenantId, created.id),
    ]) {
      await expect(call()).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_RETURN_STATUS_INVALID },
      });
    }
    // Its quantity is free again.
    await expect(open(orderId, lineId, 1)).resolves.toBeDefined();
  });

  it('inspecting a return that was never received is refused', async () => {
    const { orderId, lineId } = await shippedOrder(1);
    const created = await open(orderId, lineId, 1);
    await expect(
      returns.inspect(owner, tenantId, created.id, {
        items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_STATUS_INVALID },
    });
  });

  it('lists and finds returns inside the tenant only', async () => {
    const page = await returns.findAll(owner, tenantId, {
      page: 1,
      limit: 100,
    });
    expect(page.pagination.total).toBeGreaterThan(0);
    const [first] = page.data;
    expect((await returns.findOne(owner, tenantId, first.id)).id).toBe(
      first.id,
    );
    await expect(
      returns.findOne(owner, randomUUID(), first.id),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_RETURN_NOT_FOUND },
    });
  });
});
