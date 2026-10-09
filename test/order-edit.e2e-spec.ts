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
import { OrderEditService } from './../src/modules/orders/order-edit.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
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
  OrderLineType,
  OrderPaymentStatus,
  OrderPriority,
  OrderStatus,
} from './../src/common/constants/order-status';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';
import type { CreateOrderDto } from './../src/modules/orders/dto/create-order.dto';
import type { UpdateOrderDto } from './../src/modules/orders/dto/update-order.dto';

/**
 * Sửa đơn (A-8, OrderEditService – `PATCH /orders/:id`, `/assignee`, `/priority`) trên Postgres thật
 * (docker compose up -d): sửa dòng khi CONFIRMED (giữ / thêm / bỏ, combo co giãn), chặn sửa dòng sau
 * khi đóng gói, tiền cọc không được lệch số đã thu, dòng đã có YCSX không bỏ được, đơn POS / đã đi
 * không sửa được, và `excludePos` của `GET /orders`. Tự tạo tenant riêng và dọn sạch.
 */
describe('PATCH /orders/:id – OrderEditService', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let edits: OrderEditService;
  let reads: OrderReadService;
  let fulfillments: FulfillmentService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const otherWarehouseId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const tableId = randomUUID();
  const chairId = randomUUID();
  const comboId = randomUUID();
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

  const edit = (id: string, dto: UpdateOrderDto) =>
    edits.update(owner, tenantId, id, dto);

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { getResponse(): { code: string } }).getResponse().code;
    }
    return undefined;
  };

  const orderRow = (id: string) =>
    prisma.order.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

  const topLines = async (id: string) =>
    (await orderRow(id)).items.filter((line) => !line.parentItemId);

  const lineOf = async (id: string, productItemId: string) =>
    (await topLines(id)).find((line) => line.productItemId === productItemId)!;

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
        OrderEditService,
        OrderReadService,
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
    edits = moduleRef.get(OrderEditService);
    reads = moduleRef.get(OrderReadService);
    fulfillments = moduleRef.get(FulfillmentService);
    const inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'edit-e2e' } });
    for (const [id, role] of [
      [ownerId, SystemRole.TENANT_OWNER],
      [staffId, SystemRole.STAFF],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          tenantId,
          phoneNumber: `edit-${id}`,
          systemRole: role,
          status: UserStatus.ACTIVE,
        },
      });
    }
    for (const id of [warehouseId, otherWarehouseId]) {
      await prisma.location.create({
        data: {
          id,
          tenantId,
          name: `Kho ${id.slice(0, 4)}`,
          type: 'WAREHOUSE',
        },
      });
      await prisma.warehouse.create({
        data: { id, tenantId, locationId: id },
      });
    }
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
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    for (const [id, name, price, itemType] of [
      [sofaId, 'Sofa', 10_000_000, 'PRODUCT'],
      [tableId, 'Bàn ăn', 2_000_000, 'PRODUCT'],
      [chairId, 'Ghế ăn', 500_000, 'PRODUCT'],
      [comboId, 'Bộ bàn ăn 4 ghế', 3_500_000, 'COMBO'],
    ] as const) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `EDIT-${id}`,
          sku: `EDIT-${id.slice(0, 8)}`,
          retailPrice: price,
          costPrice: 0,
          itemType,
        },
      });
    }
    await prisma.comboComponent.createMany({
      data: [
        { comboItemId: comboId, componentItemId: tableId, quantity: 1 },
        { comboItemId: comboId, componentItemId: chairId, quantity: 4 },
      ],
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
          referenceId: 'edit-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.productionRequestItem.deleteMany({
      where: { productionRequest: { tenantId } },
    });
    await prisma.productionRequest.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({
      where: { order: { tenantId }, parentItemId: { not: null } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.comboComponent.deleteMany({
      where: { comboItem: { tenantId } },
    });
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

  it('changes delivery details, priority and note, leaving the rest as it was', async () => {
    const id = await createOrder({ note: 'cũ', recipientName: 'A' });
    const before = await orderRow(id);

    const detail = await edit(id, {
      priority: OrderPriority.URGENT,
      deliveryAddress: '12 Lê Lợi',
      requestedDeliveryDate: '2026-10-20',
      note: 'giao buổi sáng',
    });

    const after = await orderRow(id);
    expect(after.priority).toBe(OrderPriority.URGENT);
    expect(after.deliveryAddress).toBe('12 Lê Lợi');
    expect(after.note).toBe('giao buổi sáng');
    expect(after.recipientName).toBe('A');
    expect(Number(after.grandTotal)).toBe(Number(before.grandTotal));
    expect(after.items.map((i) => i.id)).toEqual(before.items.map((i) => i.id));
    expect(detail).toMatchObject({ id, priority: OrderPriority.URGENT });
  });

  it('keeps, changes, adds and removes lines, and prices the order again', async () => {
    const id = await createOrder({
      items: [
        { productItemId: sofaId, quantity: 1, unitPrice: 9_000_000 },
        { productItemId: tableId, quantity: 1 },
      ],
    });
    const sofaLine = await lineOf(id, sofaId);

    await edit(id, {
      items: [
        // Kept: quantity changes, the agreed price is kept because none is sent.
        { id: sofaLine.id, productItemId: sofaId, quantity: 2 },
        // New.
        {
          productItemId: chairId,
          quantity: 3,
          sourceLocationId: otherWarehouseId,
        },
      ],
    });

    const after = await orderRow(id);
    expect(after.items).toHaveLength(2);
    const sofa = after.items.find((i) => i.id === sofaLine.id)!;
    expect(sofa.quantity).toBe(2);
    expect(Number(sofa.unitPrice)).toBe(9_000_000);
    expect(Number(sofa.listUnitPrice)).toBe(10_000_000);
    expect(Number(sofa.lineTotal)).toBe(18_000_000);
    const chair = after.items.find((i) => i.productItemId === chairId)!;
    expect(chair.sourceLocationId).toBe(otherWarehouseId);
    expect(Number(after.subtotal)).toBe(19_500_000);
    expect(Number(after.grandTotal)).toBe(19_500_000);
  });

  it('scales a combo’s components with its quantity and keeps where they ship from', async () => {
    const id = await createOrder({
      items: [
        {
          productItemId: comboId,
          quantity: 1,
          sourceLocationId: otherWarehouseId,
        },
      ],
    });
    const [combo] = await topLines(id);

    await edit(id, {
      items: [{ id: combo.id, productItemId: comboId, quantity: 2 }],
    });

    const after = await orderRow(id);
    const children = after.items.filter((i) => i.parentItemId === combo.id);
    expect(children).toHaveLength(2);
    expect(
      Object.fromEntries(children.map((c) => [c.productItemId, c.quantity])),
    ).toEqual({ [tableId]: 2, [chairId]: 8 });
    expect(children.every((c) => c.sourceLocationId === otherWarehouseId)).toBe(
      true,
    );
    expect(Number(after.grandTotal)).toBe(7_000_000);
  });

  it('adds a new combo with its components', async () => {
    const id = await createOrder();
    const [sofaLine] = await topLines(id);

    await edit(id, {
      items: [
        { id: sofaLine.id, productItemId: sofaId, quantity: 2 },
        { productItemId: comboId, quantity: 1 },
      ],
    });

    const after = await orderRow(id);
    const combo = after.items.find((i) => i.productItemId === comboId)!;
    expect(combo.lineType).toBe(OrderLineType.COMBO);
    expect(after.items.filter((i) => i.parentItemId === combo.id)).toHaveLength(
      2,
    );
  });

  it('refuses a line id from another order, and a kept line changing product', async () => {
    const id = await createOrder();
    const other = await createOrder();
    const [otherLine] = await topLines(other);
    const [line] = await topLines(id);

    expect(
      await codeOf(
        edit(id, {
          items: [{ id: otherLine.id, productItemId: sofaId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_ITEM_NOT_FOUND);
    expect(
      await codeOf(
        edit(id, {
          items: [{ id: line.id, productItemId: tableId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_NOT_EDITABLE);
  });

  it('refuses to drop a line a production request was raised for', async () => {
    const id = await createOrder({
      items: [
        { productItemId: sofaId, quantity: 1 },
        { productItemId: tableId, quantity: 1 },
      ],
    });
    const sofaLine = await lineOf(id, sofaId);
    const tableLine = await lineOf(id, tableId);
    await prisma.productionRequest.create({
      data: {
        tenantId,
        code: `YCSX-${id.slice(0, 8)}`,
        supplierId: workshopId,
        locationId: warehouseId,
        status: 'SENT',
        items: {
          create: {
            productItemId: tableId,
            orderItemId: tableLine.id,
            quantity: 1,
          },
        },
      },
    });

    expect(
      await codeOf(
        edit(id, {
          items: [{ id: sofaLine.id, productItemId: sofaId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_ITEM_IN_PRODUCTION);
    expect(await topLines(id)).toHaveLength(2);
  });

  it('does not let a packed order’s lines change, but still its person in charge, priority and note', async () => {
    const id = await createOrder();
    const [line] = await topLines(id);
    await fulfillments.packOrder(owner, id, {});

    expect(
      await codeOf(
        edit(id, {
          items: [{ id: line.id, productItemId: sofaId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_NOT_EDITABLE);

    await edit(id, { note: 'đã gói, giao chiều' });
    await edits.setAssignee(owner, tenantId, id, { assigneeId: staffId });
    await edits.setPriority(owner, tenantId, id, {
      priority: OrderPriority.HIGH,
    });
    const after = await orderRow(id);
    expect(after.status).toBe(OrderStatus.PACKED);
    expect(after.note).toBe('đã gói, giao chiều');
    expect(after.assigneeId).toBe(staffId);
    expect(after.priority).toBe(OrderPriority.HIGH);
    expect(after.items[0].quantity).toBe(2);
  });

  it('refuses any edit once the order is shipping, and a till sale', async () => {
    const id = await createOrder();
    await prisma.order.update({
      where: { id },
      data: { status: OrderStatus.SHIPPING },
    });
    expect(await codeOf(edit(id, { note: 'x' }))).toBe(
      ErrorCode.ORDER_NOT_EDITABLE,
    );
    expect(
      await codeOf(
        edits.setPriority(owner, tenantId, id, {
          priority: OrderPriority.URGENT,
        }),
      ),
    ).toBe(ErrorCode.ORDER_NOT_EDITABLE);

    const till = await createOrder();
    await prisma.order.update({
      where: { id: till },
      data: { fulfillmentType: FulfillmentType.TAKEAWAY },
    });
    expect(await codeOf(edit(till, { note: 'x' }))).toBe(
      ErrorCode.ORDER_NOT_EDITABLE,
    );
  });

  it('refuses a person in charge who is not an active account of the shop', async () => {
    const id = await createOrder();
    expect(
      await codeOf(
        edits.setAssignee(owner, tenantId, id, { assigneeId: randomUUID() }),
      ),
    ).toBe(ErrorCode.ORDER_ASSIGNEE_INVALID);
  });

  it('refuses an edit that would move a percentage deposit off the money taken, and accepts it resent as the amount held', async () => {
    const id = await createOrder({
      items: [{ productItemId: sofaId, quantity: 1 }],
      deposit: { type: 'PERCENT', value: 30, method: 'CASH' },
    });
    const [line] = await topLines(id);

    expect(
      await codeOf(
        edit(id, {
          items: [{ id: line.id, productItemId: sofaId, quantity: 2 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_DEPOSIT_CHANGED);
    expect((await topLines(id))[0].quantity).toBe(1);

    await edit(id, {
      items: [{ id: line.id, productItemId: sofaId, quantity: 2 }],
      deposit: { type: 'AMOUNT', value: 3_000_000, method: 'CASH' },
    });
    const after = await orderRow(id);
    expect(Number(after.grandTotal)).toBe(20_000_000);
    expect(Number(after.depositAmount)).toBe(3_000_000);
    expect(after.depositPercent).toBeNull();
    expect(after.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
  });

  it('refuses an amount deposit larger than the new total', async () => {
    const id = await createOrder({
      items: [
        { productItemId: sofaId, quantity: 1 },
        { productItemId: tableId, quantity: 1 },
      ],
      deposit: { type: 'AMOUNT', value: 11_000_000, method: 'CASH' },
    });
    const sofaLine = await lineOf(id, sofaId);
    expect(
      await codeOf(
        edit(id, {
          items: [{ id: sofaLine.id, productItemId: sofaId, quantity: 1 }],
        }),
      ),
    ).toBe(ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL);
  });

  it('adds the shipping fee and a manual discount to the total', async () => {
    const id = await createOrder();
    await edit(id, {
      shippingFee: 300_000,
      discountType: 'ORDER',
      discountValue: 1_000_000,
    });
    let after = await orderRow(id);
    expect(Number(after.grandTotal)).toBe(19_300_000);

    await edit(id, { shippingFee: 0 });
    after = await orderRow(id);
    expect(Number(after.grandTotal)).toBe(19_000_000);
    expect(after.discountType).toBe('ORDER');
  });

  it('leaves the till’s sales out of GET /orders with excludePos', async () => {
    const journey = await createOrder();
    const till = await createOrder();
    await prisma.order.update({
      where: { id: till },
      data: { fulfillmentType: FulfillmentType.TAKEAWAY },
    });

    const ids = async (query: object) =>
      (
        (await reads.findAll(owner, tenantId, {
          page: 1,
          limit: 100,
          ...query,
        })) as { data: { id: string }[] }
      ).data.map((o) => o.id);

    expect(await ids({})).toEqual(expect.arrayContaining([journey, till]));
    const filtered = await ids({ excludePos: true });
    expect(filtered).toContain(journey);
    expect(filtered).not.toContain(till);
  });
});
