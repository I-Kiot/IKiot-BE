import 'dotenv/config';
import { InvoiceService } from './../src/modules/invoices/invoices.service';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCustomizationService } from './../src/modules/orders/order-customization.service';
import { OrderShortageAlerts } from './../src/modules/orders/order-shortage-alerts';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { OrderHeldSettleService } from './../src/modules/orders/order-held-settle.service';
import { StatsReportsService } from './../src/modules/stats/stats-reports.service';
import {
  heldUndecidedOf,
  loadHeldUndecided,
} from './../src/modules/orders/held-undecided';
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
import { writePaymentCashFlow } from './../src/modules/orders/order-cash-flow';
import { syncOrderPaymentStatus } from './../src/modules/orders/payment-status';
import { CashFlowCategory } from './../src/common/constants/cash-flow-category';
import { OrderPaymentStatus } from './../src/common/constants/order-status';
import { PaymentKind } from './../src/common/constants/payment-method';
import { assertMoneyInvariants } from './helpers/money-invariants';

/**
 * Hoàn hàng (D-5) trên Postgres thật: tạo đơn hoàn → nhận hàng → kiểm từng dòng. GOOD cộng lại tồn bán được, DAMAGED vào kho hàng hỏng; vượt số lượng, đơn chưa trừ kho, người không có quyền đều bị chặn. `ship` (C-2) chưa có route nên test tự trừ tồn bằng `shipLockedStock`. Tự tạo tenant riêng và dọn sạch.
 */
describe('/order-returns – OrderReturnService', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let returns: OrderReturnService;
  let heldSettle: OrderHeldSettleService;
  let reads: OrderReadService;
  let reports: StatsReportsService;
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

  /** Đơn đã giao: đóng gói rồi trừ kho như `ship` sẽ làm (sổ SALE kèm dòng đơn). */
  const shippedOrder = async (quantity = 2, assigneeId = ownerId) => {
    const created = await manual.create(owner, tenantId, {
      branchId,
      customerId,
      assigneeId,
      fulfillmentType: 'HOME_DELIVERY',
      recipientName: 'Khách e2e',
      recipientPhone: '0912345678',
      deliveryAddress: '1 Tràng Tiền, Hà Nội',
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

  /** Khoản đã thu của đơn (kèm dòng sổ thu chi, như code thật), rồi đồng bộ trạng thái thanh toán. */
  const pay = async (
    orderId: string,
    kind: string,
    amount: number,
    method = 'BANK_TRANSFER',
  ) =>
    prisma.$transaction(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const payment = await tx.payment.create({
        data: {
          tenantId,
          orderId,
          kind,
          method,
          amount,
          status: 'PAID',
          paidAt: new Date(),
          locationId: branchId,
          createdById: ownerId,
        },
      });
      await writePaymentCashFlow(tx, {
        tenantId,
        payment,
        category: CashFlowCategory.ORDER_PAYMENT,
        orderId,
        orderCode: order.code,
        locationId: branchId,
        createdById: ownerId,
        description: 'e2e payment',
      });
      await syncOrderPaymentStatus(tx, orderId);
    });
  const grandTotalOf = async (orderId: string) =>
    Number(
      (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
        .grandTotal,
    );
  const refundsOf = (orderId: string) =>
    prisma.payment.findMany({ where: { orderId, kind: PaymentKind.REFUND } });
  const received = async (
    orderId: string,
    lineId: string,
    quantity: number,
  ) => {
    const created = await open(orderId, lineId, quantity);
    await returns.receive(owner, tenantId, created.id);
    return created;
  };
  const orderOf = (orderId: string) =>
    prisma.order.findUniqueOrThrow({ where: { id: orderId } });

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
        InvoiceService,
        OrderService,
        OrderPricingService,
        ManualOrderService,
        OrderCustomizationService,
        OrderShortageAlerts,
        ProductionListService,
        OrderReadService,
        OrderHeldSettleService,
        StatsReportsService,
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
    heldSettle = moduleRef.get(OrderHeldSettleService);
    reads = moduleRef.get(OrderReadService);
    reports = moduleRef.get(StatsReportsService);
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
    // Người phụ trách đơn phải làm việc tại nơi bán của đơn.
    await prisma.user.update({
      where: { id: staffId },
      data: { locationId: branchId },
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
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
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
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
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
    expect(await stockAt(warehouseId)).toBe(before - 2);

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

    // Hoàn đủ nên lần kiểm này là lần đổi đơn sang RETURNED: sự kiện mang cả trạng thái.
    const trail = await prisma.orderEvent.findMany({
      where: { orderId, type: { startsWith: 'RETURN_' } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    expect(trail.map((e) => e.type)).toEqual([
      'RETURN_CREATED',
      'RETURN_RECEIVED',
      'RETURN_INSPECTED',
    ]);
    expect(trail[0].metadata).toMatchObject({
      refType: 'ORDER_RETURN',
      refId: created.id,
      refCode: created.code,
      reason: 'CUSTOMER_RETURN',
    });
    expect(trail[2]).toMatchObject({
      fromStatus: expect.any(String),
      toStatus: OrderStatus.RETURNED,
      metadata: { good: 2, damaged: 0 },
    });
  });

  it('sends damaged goods to the damaged-goods warehouse and leaves the order un-RETURNED on a partial return', async () => {
    const before = await stockAt(warehouseId);
    const { orderId, lineId } = await shippedOrder(3);
    const created = await open(orderId, lineId, 1);
    await returns.receive(owner, tenantId, created.id);
    await returns.inspect(owner, tenantId, created.id, {
      items: [{ orderItemId: lineId, condition: ReturnCondition.DAMAGED }],
    });

    expect(await stockAt(warehouseId)).toBe(before - 3); // Không phải tồn bán được
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
      recipientName: 'Khách e2e',
      recipientPhone: '0912345678',
      deliveryAddress: '1 Tràng Tiền, Hà Nội',
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
    // Phiếu đang mở đã giữ số lượng: 2/2 đã bị giữ nên thêm 1 nữa cũng là thừa.
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
    await expect(open(orderId, lineId, 1)).resolves.toBeDefined();
    // Các lần bị từ chối không ghi gì: chỉ RETURN_CREATED (hai lần mở) và một RETURN_CANCELLED.
    const types = (
      await prisma.orderEvent.findMany({
        where: { orderId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })
    )
      .map((e) => e.type)
      .filter((type) => type.startsWith('RETURN_'));
    expect(types).toEqual([
      'RETURN_CREATED',
      'RETURN_CANCELLED',
      'RETURN_CREATED',
    ]);
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

  describe('hoàn tiền khi kiểm hàng trả (Phase 6)', () => {
    it('suggests the goods value, demands an explicit refund, then refunds the whole price: REFUND payment + ORDER_REFUND flow + REFUNDED event, payment REFUNDED', async () => {
      const { orderId, lineId } = await shippedOrder(2);
      const total = await grandTotalOf(orderId);
      await pay(orderId, PaymentKind.FULL, total);
      const created = await received(orderId, lineId, 2);

      const reading = await returns.findOne(owner, tenantId, created.id);
      expect(reading.refundSuggestion).toEqual({
        suggested: total,
        max: total,
        goodsValue: total,
        shippingFee: 0,
        received: total,
        refunded: 0,
      });

      const before = await stockAt(warehouseId);
      await expect(
        returns.inspect(owner, tenantId, created.id, {
          items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_RETURN_REFUND_REQUIRED, held: total },
      });
      expect((await returns.findOne(owner, tenantId, created.id)).status).toBe(
        OrderReturnStatus.INSPECTING,
      );
      expect(await stockAt(warehouseId)).toBe(before);

      const done = await returns.inspect(owner, tenantId, created.id, {
        items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
        refund: {
          amount: total,
          method: 'BANK_TRANSFER',
          note: 'Khách trả hàng',
        },
      });
      expect(done.status).toBe(OrderReturnStatus.COMPLETED);
      expect(done.refundSuggestion).toBeNull();

      const [refund] = await refundsOf(orderId);
      expect(Number(refund.amount)).toBe(total);
      expect(refund).toMatchObject({
        method: 'BANK_TRANSFER',
        status: 'PAID',
        createdById: ownerId,
        locationId: branchId,
        note: 'Khách trả hàng',
      });
      expect(refund.refundOfPaymentId).not.toBeNull();
      const flow = await prisma.cashFlow.findFirstOrThrow({
        where: { orderId, category: 'ORDER_REFUND' },
      });
      expect(flow).toMatchObject({
        flowType: 'EXPENSE',
        paymentId: refund.id,
        fund: 'BANK',
        locationId: branchId,
        createdById: ownerId,
      });
      expect(Number(flow.amount)).toBe(total);
      const order = await orderOf(orderId);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.REFUNDED);
      expect(order.status).toBe(OrderStatus.RETURNED);

      const trail = await prisma.orderEvent.findMany({
        where: { orderId, type: { in: ['RETURN_INSPECTED', 'REFUNDED'] } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      expect(trail.map((e) => e.type)).toEqual([
        'RETURN_INSPECTED',
        'REFUNDED',
      ]);
      expect(trail[1]).toMatchObject({ actorId: ownerId });
      expect(trail[1].metadata).toMatchObject({
        amount: total,
        method: 'BANK_TRANSFER',
        paymentId: refund.id,
        reason: 'RETURN_INSPECTION',
        refType: 'ORDER_RETURN',
        refId: created.id,
      });
    });

    it('a partial return gets a partial refund (cash leaves the order branch drawer); a later return may keep the money with refund 0', async () => {
      const { orderId, lineId } = await shippedOrder(3);
      const total = await grandTotalOf(orderId);
      const unit = total / 3;
      await pay(orderId, PaymentKind.FULL, total, 'CASH');

      const first = await received(orderId, lineId, 1);
      expect(
        (await returns.findOne(owner, tenantId, first.id)).refundSuggestion,
      ).toMatchObject({ suggested: unit, max: total, goodsValue: unit });
      await returns.inspect(owner, tenantId, first.id, {
        items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
        refund: { amount: 4_000_000, method: 'CASH' },
      });
      let order = await orderOf(orderId);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_REFUNDED);
      expect(order.status).toBe(OrderStatus.SHIPPING);
      const flow = await prisma.cashFlow.findFirstOrThrow({
        where: { orderId, category: 'ORDER_REFUND' },
      });
      expect(flow).toMatchObject({ fund: 'DRAWER', locationId: branchId });

      // The suggestion now reflects what is still held; refund 0 writes no money.
      const second = await received(orderId, lineId, 1);
      expect(
        (await returns.findOne(owner, tenantId, second.id)).refundSuggestion,
      ).toMatchObject({
        suggested: unit,
        max: total - 4_000_000,
        received: total,
        refunded: 4_000_000,
      });
      await returns.inspect(owner, tenantId, second.id, {
        items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
        refund: { amount: 0 },
      });
      expect(await refundsOf(orderId)).toHaveLength(1);
      order = await orderOf(orderId);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_REFUNDED);
    });

    it('refuses a refund above what the order holds, and any refund on an unpaid order; the whole inspection rolls back', async () => {
      const { orderId, lineId } = await shippedOrder(1);
      const total = await grandTotalOf(orderId);
      await pay(orderId, PaymentKind.FULL, total);
      const created = await received(orderId, lineId, 1);
      const before = await stockAt(warehouseId);
      await expect(
        returns.inspect(owner, tenantId, created.id, {
          items: [{ orderItemId: lineId, condition: ReturnCondition.GOOD }],
          refund: { amount: total + 1, method: 'CASH' },
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID, max: total },
      });
      expect(await stockAt(warehouseId)).toBe(before);
      expect(await refundsOf(orderId)).toHaveLength(0);
      expect(
        (await prisma.orderItem.findUniqueOrThrow({ where: { id: lineId } }))
          .returnedQuantity,
      ).toBe(0);
      expect((await returns.findOne(owner, tenantId, created.id)).status).toBe(
        OrderReturnStatus.INSPECTING,
      );

      const unpaid = await shippedOrder(1);
      const other = await received(unpaid.orderId, unpaid.lineId, 1);
      await expect(
        returns.inspect(owner, tenantId, other.id, {
          items: [
            { orderItemId: unpaid.lineId, condition: ReturnCondition.GOOD },
          ],
          refund: { amount: 1000, method: 'CASH' },
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID },
      });
      // Nothing is held, so no refund is needed.
      await returns.inspect(owner, tenantId, other.id, {
        items: [
          { orderItemId: unpaid.lineId, condition: ReturnCondition.GOOD },
        ],
      });
    });

    it('a return before the order completed: the deposit is refunded, or kept with refund 0 (order stays PARTIALLY_PAID)', async () => {
      const refunded = await shippedOrder(1);
      await pay(refunded.orderId, PaymentKind.DEPOSIT, 3_000_000);
      const a = await received(refunded.orderId, refunded.lineId, 1);
      await returns.inspect(owner, tenantId, a.id, {
        items: [
          { orderItemId: refunded.lineId, condition: ReturnCondition.GOOD },
        ],
        refund: { amount: 3_000_000, method: 'CASH' },
      });
      expect((await orderOf(refunded.orderId)).paymentStatus).toBe(
        OrderPaymentStatus.REFUNDED,
      );

      const kept = await shippedOrder(1);
      await pay(kept.orderId, PaymentKind.DEPOSIT, 3_000_000);
      const b = await received(kept.orderId, kept.lineId, 1);
      await returns.inspect(owner, tenantId, b.id, {
        items: [{ orderItemId: kept.lineId, condition: ReturnCondition.GOOD }],
        refund: { amount: 0 },
      });
      expect(await refundsOf(kept.orderId)).toHaveLength(0);
      const order = await orderOf(kept.orderId);
      expect(order.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
      expect(order.status).toBe(OrderStatus.RETURNED);
      // Trả trước khi hoàn thành: không có SALE để đảo; tiền cọc shop giữ là thu nhập khác (D3). Đơn đã hoàn hết cọc thì không có gì.
      const keptJournal = await prisma.salesJournalEntry.findMany({
        where: { orderId: kept.orderId },
      });
      expect(keptJournal.map((e) => e.entryType)).toEqual(['OTHER_INCOME']);
      expect(Number(keptJournal[0].totalAmount)).toBe(3_000_000);
      expect(
        await prisma.salesJournalEntry.count({
          where: { orderId: refunded.orderId },
        }),
      ).toBe(0);
    });

    /** Giao thất bại, hàng về đủ, KHÔNG nêu số hoàn: đơn RETURNED, tiền cọc treo. */
    const failedDeliveryHeld = async (deposit: number, refundZero = false) => {
      const { orderId } = await shippedOrder(1);
      await pay(orderId, PaymentKind.DEPOSIT, deposit);
      const fulfillment = await prisma.fulfillment.findFirstOrThrow({
        where: { orderId },
      });
      const shipment = await prisma.shipment.create({
        data: {
          tenantId,
          orderId,
          fulfillmentId: fulfillment.id,
          carrierType: 'INTERNAL',
          status: 'FAILED',
        },
      });
      await returns.confirmFailedDelivery(owner, tenantId, {
        shipmentId: shipment.id,
        ...(refundZero ? { refund: { amount: 0 } } : {}),
      });
      return orderId;
    };
    const otherIncomeOf = (orderId: string) =>
      prisma.salesJournalEntry.findMany({
        where: { orderId, entryType: 'OTHER_INCOME' },
        orderBy: { postedAt: 'asc' },
      });
    const heldOf = async (orderId: string) =>
      (await reads.findOne(owner, tenantId, orderId)).paymentSummary
        .heldUndecided;

    it('a failed delivery without a refund decision posts NO other income: the deposit stays held, undecided', async () => {
      const orderId = await failedDeliveryHeld(2_000_000);
      expect(await refundsOf(orderId)).toHaveLength(0);
      expect((await orderOf(orderId)).status).toBe(OrderStatus.RETURNED);
      expect(await otherIncomeOf(orderId)).toHaveLength(0);
      expect(
        await prisma.$transaction((tx) => loadHeldUndecided(tx, orderId)),
      ).toBe(2_000_000);
      expect(await heldOf(orderId)).toBe(2_000_000);
      const report = await reports.getUnreconciled(owner);
      const row = report.heldUndecided.items.find((r) => r.orderId === orderId);
      expect(row?.held).toBe(2_000_000);
      expect(report.heldUndecided.amount).toBeGreaterThanOrEqual(2_000_000);
    });

    it('a failed delivery with refund 0 keeps the deposit as other income right away', async () => {
      const orderId = await failedDeliveryHeld(1_500_000, true);
      const journal = await otherIncomeOf(orderId);
      expect(journal).toHaveLength(1);
      expect(Number(journal[0].otherIncomeAmount)).toBe(1_500_000);
      expect(await heldOf(orderId)).toBe(0);
    });

    it('settle-held: a partial REFUND, then KEEP the rest (other income dated at the decision); a second press does nothing', async () => {
      const orderId = await failedDeliveryHeld(3_000_000);
      const before = new Date();
      await heldSettle.settle(owner, tenantId, orderId, {
        action: 'REFUND',
        amount: 1_000_000,
        method: 'BANK_TRANSFER',
        note: 'khách xin hoàn một phần',
      });
      const refunds = await refundsOf(orderId);
      expect(refunds.map((r) => Number(r.amount))).toEqual([1_000_000]);
      expect(
        await prisma.cashFlow.count({
          where: { orderId, category: CashFlowCategory.ORDER_REFUND },
        }),
      ).toBe(1);
      // Phần còn lại vẫn treo.
      expect(await otherIncomeOf(orderId)).toHaveLength(0);
      expect(await heldOf(orderId)).toBe(2_000_000);
      // Hoàn vượt phần treo bị chặn.
      await expect(
        heldSettle.settle(owner, tenantId, orderId, {
          action: 'REFUND',
          amount: 2_000_001,
          method: 'CASH',
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_REFUND_EXCEEDS_PAID },
      });

      const results = await Promise.allSettled([
        heldSettle.settle(owner, tenantId, orderId, { action: 'KEEP' }),
        heldSettle.settle(owner, tenantId, orderId, { action: 'KEEP' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.reason).toMatchObject({
        response: { code: ErrorCode.ORDER_NO_HELD_MONEY },
      });
      const journal = await otherIncomeOf(orderId);
      expect(journal).toHaveLength(1);
      expect(Number(journal[0].otherIncomeAmount)).toBe(2_000_000);
      // Ghi ở ngày quyết định, không lùi ngày.
      expect(journal[0].postedAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime(),
      );
      expect(journal[0].source).toBe('HELD_DECISION');
      expect(await heldOf(orderId)).toBe(0);
      const events = await prisma.orderEvent.findMany({
        where: { orderId, type: { in: ['REFUNDED', 'HELD_KEPT'] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual(['REFUNDED', 'HELD_KEPT']);
      const report = await reports.getUnreconciled(owner);
      expect(
        report.heldUndecided.items.some((r) => r.orderId === orderId),
      ).toBe(false);
    });

    it('settle-held refuses an order that is not finished; the rule is pure', async () => {
      const { orderId } = await shippedOrder(1);
      await pay(orderId, PaymentKind.DEPOSIT, 500_000);
      await expect(
        heldSettle.settle(owner, tenantId, orderId, { action: 'KEEP' }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_NO_HELD_MONEY },
      });
      const base = {
        status: OrderStatus.RETURNED,
        hasSale: false,
        hasOtherIncome: false,
        net: 10,
      };
      expect(heldUndecidedOf(base)).toBe(10);
      expect(heldUndecidedOf({ ...base, hasSale: true })).toBe(0);
      expect(heldUndecidedOf({ ...base, hasOtherIncome: true })).toBe(0);
      expect(heldUndecidedOf({ ...base, status: OrderStatus.SHIPPING })).toBe(
        0,
      );
    });
  });

  it('leaves the money ledger consistent', async () => {
    await assertMoneyInvariants(prisma, tenantId);
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
