import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { SepayOrderService } from './../src/modules/orders/sepay-order.service';
import { CustomerService } from './../src/modules/customers/customers.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import {
  OrderChannel,
  OrderLineType,
  OrderPaymentStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
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
 * Tạo đơn tay (A-2, ManualOrderService.create – `POST /orders`) trên Postgres thật
 * (docker compose up -d): đơn sinh ra CONFIRMED, chụp giá, chọn kho xuất mặc định, bung combo,
 * ghi tiền cọc, và các lỗi chặn. Tự tạo tenant riêng và dọn sạch, chạy lại bao nhiêu lần cũng được.
 */
describe('POST /orders – ManualOrderService.create', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let orders: OrderService;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const inactiveId = randomUUID();
  const strangerId = randomUUID(); // ACTIVE, nhưng ở tenant khác
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const warehouseId = randomUUID(); // kho xuất mặc định của chi nhánh
  const damagedId = randomUUID(); // kho hàng hỏng
  const productId = randomUUID();
  const sofaId = randomUUID(); // 10.000.000
  const tableId = randomUUID(); // 2.000.000
  const chairId = randomUUID(); // 500.000
  const comboId = randomUUID(); // bàn + 4 ghế, 3.500.000
  const emptyComboId = randomUUID();
  const wardrobeId = randomUUID(); // 4.000.000
  const deskComboId = randomUUID(); // combo tủ bàn: 1 bàn + 2 tủ
  const roomComboId = randomUUID(); // combo của combo: 1 combo tủ bàn + 1 bộ bàn ăn + 2 ghế
  const loopAId = randomUUID(); // A chứa B, B chứa A
  const loopBId = randomUUID();
  const customerId = randomUUID();

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  /** Nhân viên ở chi nhánh kia, không có `orders:view_all`. */
  const staffElsewhere = {
    ...owner,
    userId: staffId,
    systemRole: SystemRole.STAFF,
    branchId: otherBranchId,
  } as unknown as AuthUser;

  const base = (over: Partial<CreateOrderDto> = {}): CreateOrderDto => ({
    branchId,
    customerId,
    assigneeId: staffId,
    fulfillmentType: 'HOME_DELIVERY',
    items: [{ productItemId: sofaId, quantity: 1 }],
    ...over,
  });

  const create = (dto: CreateOrderDto, user: AuthUser = owner) =>
    manual.create(user, tenantId, dto);

  const orderCount = () => prisma.order.count({ where: { tenantId } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        OrderService,
        OrderPricingService,
        ManualOrderService,
        CustomerService,
        { provide: InventoryService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
        { provide: PromotionService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    manual = moduleRef.get(ManualOrderService);
    orders = moduleRef.get(OrderService);

    await prisma.tenant.createMany({
      data: [
        { id: tenantId, name: 'order-create-e2e' },
        { id: otherTenantId, name: 'order-create-e2e-other' },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: `oc-${ownerId}`,
          systemRole: SystemRole.TENANT_OWNER,
          status: UserStatus.ACTIVE,
        },
        {
          id: staffId,
          tenantId,
          phoneNumber: `oc-${staffId}`,
          systemRole: SystemRole.STAFF,
          status: UserStatus.ACTIVE,
        },
        {
          id: inactiveId,
          tenantId,
          phoneNumber: `oc-${inactiveId}`,
          systemRole: SystemRole.STAFF,
          status: UserStatus.INACTIVE,
        },
        {
          id: strangerId,
          tenantId: otherTenantId,
          phoneNumber: `oc-${strangerId}`,
          systemRole: SystemRole.STAFF,
          status: UserStatus.ACTIVE,
        },
      ],
    });
    await prisma.location.createMany({
      data: [
        { id: warehouseId, tenantId, name: 'Kho tổng', type: 'WAREHOUSE' },
        {
          id: damagedId,
          tenantId,
          name: 'Kho hàng hỏng',
          type: 'WAREHOUSE',
          isSellable: false,
        },
        {
          id: otherBranchId,
          tenantId,
          name: 'CN 2',
          type: 'BRANCH',
        },
      ],
    });
    await prisma.location.create({
      data: {
        id: branchId,
        tenantId,
        name: 'CN 1',
        type: 'BRANCH',
        defaultFulfillmentLocationId: warehouseId,
      },
    });
    await prisma.branch.createMany({
      data: [
        { id: branchId, tenantId, locationId: branchId },
        { id: otherBranchId, tenantId, locationId: otherBranchId },
      ],
    });
    await prisma.warehouse.createMany({
      data: [
        { id: warehouseId, tenantId, locationId: warehouseId },
        { id: damagedId, tenantId, locationId: damagedId },
      ],
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    for (const [id, name, price, itemType] of [
      [sofaId, 'Sofa', 10_000_000, 'PRODUCT'],
      [tableId, 'Bàn ăn', 2_000_000, 'PRODUCT'],
      [chairId, 'Ghế ăn', 500_000, 'PRODUCT'],
      [comboId, 'Bộ bàn ăn 4 ghế', 3_500_000, 'COMBO'],
      [emptyComboId, 'Combo rỗng', 1_000_000, 'COMBO'],
      [wardrobeId, 'Tủ', 4_000_000, 'PRODUCT'],
      [deskComboId, 'Combo tủ bàn', 9_000_000, 'COMBO'],
      [roomComboId, 'Combo phòng', 13_000_000, 'COMBO'],
      [loopAId, 'Combo vòng A', 1_000_000, 'COMBO'],
      [loopBId, 'Combo vòng B', 1_000_000, 'COMBO'],
    ] as const) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `OC-${id}`,
          sku: `OC-${id.slice(0, 8)}`,
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
        { comboItemId: deskComboId, componentItemId: tableId, quantity: 1 },
        { comboItemId: deskComboId, componentItemId: wardrobeId, quantity: 2 },
        { comboItemId: roomComboId, componentItemId: deskComboId, quantity: 1 },
        { comboItemId: roomComboId, componentItemId: comboId, quantity: 1 },
        { comboItemId: roomComboId, componentItemId: chairId, quantity: 2 },
        { comboItemId: loopAId, componentItemId: loopBId, quantity: 1 },
        { comboItemId: loopBId, componentItemId: loopAId, quantity: 1 },
      ],
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách quen' },
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({
      where: { order: { tenantId }, parentItemId: { not: null } },
    });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.comboComponent.deleteMany({
      where: { comboItem: { tenantId } },
    });
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
    await prisma.user.deleteMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.$disconnect();
  });

  it('creates a CONFIRMED manual order with its person in charge and a price snapshot, touching no stock', async () => {
    const order = await create(
      base({ items: [{ productItemId: sofaId, quantity: 2 }] }),
    );
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true, payments: true },
    });

    expect(row.status).toBe(OrderStatus.CONFIRMED);
    expect(row.channel).toBe(OrderChannel.MANUAL);
    expect(row.assigneeId).toBe(staffId);
    expect(row.confirmedById).toBe(ownerId);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.code).toMatch(/^ORD/);
    expect(row.paymentStatus).toBe(OrderPaymentStatus.UNPAID);
    expect(row.payments).toHaveLength(0);
    expect(Number(row.grandTotal)).toBe(20_000_000);

    const [line] = row.items;
    expect(Number(line.listUnitPrice)).toBe(10_000_000);
    expect(Number(line.unitPrice)).toBe(10_000_000);
    expect(Number(line.lineTotal)).toBe(20_000_000);
    // The branch's default ship-from warehouse, not the branch.
    expect(line.sourceLocationId).toBe(warehouseId);
    expect(line.lineType).toBe(OrderLineType.PRODUCT);

    expect(await prisma.inventory.count({ where: { tenantId } })).toBe(0);
  });

  it('keeps a negotiated price beside the list price and adds shipping after the order discount', async () => {
    const order = await create(
      base({
        items: [
          {
            productItemId: sofaId,
            quantity: 1,
            unitPrice: 9_000_000,
            discountAmount: 100_000,
            sourceLocationId: branchId,
          },
        ],
        discountType: 'ORDER',
        discountValue: 400_000,
        shippingFee: 300_000,
      }),
    );
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(Number(row.items[0].listUnitPrice)).toBe(10_000_000);
    expect(Number(row.items[0].unitPrice)).toBe(9_000_000);
    expect(Number(row.items[0].lineTotal)).toBe(8_900_000);
    expect(row.items[0].sourceLocationId).toBe(branchId);
    expect(Number(row.subtotal)).toBe(8_900_000);
    expect(Number(row.shippingFee)).toBe(300_000);
    // 8.900.000 − 400.000 + 300.000
    expect(Number(row.grandTotal)).toBe(8_800_000);
  });

  it('records a percentage deposit as a PAID DEPOSIT payment', async () => {
    const order = await create(
      base({ deposit: { type: 'PERCENT', value: 30, method: 'CASH' } }),
    );
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true },
    });
    expect(Number(row.depositAmount)).toBe(3_000_000);
    expect(Number(row.depositPercent)).toBe(30);
    expect(row.paymentStatus).toBe(OrderPaymentStatus.PARTIALLY_PAID);
    expect(row.payments).toHaveLength(1);
    expect(row.payments[0]).toMatchObject({
      kind: PaymentKind.DEPOSIT,
      status: PaymentRecordStatus.PAID,
      method: 'CASH',
      locationId: branchId,
      collectedById: ownerId,
    });
    expect(Number(row.payments[0].amount)).toBe(3_000_000);
  });

  it('marks a fully paid-up deposit PAID', async () => {
    const order = await create(
      base({
        deposit: { type: 'AMOUNT', value: 10_000_000, method: 'BANK_TRANSFER' },
      }),
    );
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.paymentStatus).toBe(OrderPaymentStatus.PAID);
    expect(row.depositPercent).toBeNull();
  });

  it('refuses a deposit larger than the order, writing nothing', async () => {
    const before = await orderCount();
    await expect(
      create(
        base({
          deposit: { type: 'AMOUNT', value: 10_000_001, method: 'CASH' },
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL },
    });
    expect(await orderCount()).toBe(before);
  });

  it('expands a combo into priced parent and zero-priced component lines', async () => {
    const order = await create(
      base({ items: [{ productItemId: comboId, quantity: 2 }] }),
    );
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id },
    });
    const parent = items.find((item) => item.lineType === OrderLineType.COMBO)!;
    const children = items.filter(
      (item) => item.lineType === OrderLineType.COMBO_COMPONENT,
    );

    expect(Number(parent.lineTotal)).toBe(7_000_000);
    expect(parent.sourceLocationId).toBeNull();
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.parentItemId).toBe(parent.id);
      expect(Number(child.unitPrice)).toBe(0);
      expect(Number(child.lineTotal)).toBe(0);
      expect(child.sourceLocationId).toBe(warehouseId);
    }
    const quantities = Object.fromEntries(
      children.map((child) => [child.productItemId, child.quantity]),
    );
    expect(quantities).toEqual({ [tableId]: 2, [chairId]: 8 });
    expect(
      Number(
        (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
          .grandTotal,
      ),
    ).toBe(7_000_000);
  });

  it('flattens a combo of combos into its leaves under the one priced line', async () => {
    const order = await create(
      base({ items: [{ productItemId: roomComboId, quantity: 2 }] }),
    );
    const items = await prisma.orderItem.findMany({
      where: { orderId: order.id },
    });
    const parent = items.find((item) => item.lineType === OrderLineType.COMBO)!;
    const children = items.filter((item) => item.id !== parent.id);

    expect(parent.productItemId).toBe(roomComboId);
    expect(Number(parent.lineTotal)).toBe(26_000_000);
    // No line for the inner combos - only goods, each under the combo that was sold.
    expect(
      children.every((c) => c.lineType === OrderLineType.COMBO_COMPONENT),
    ).toBe(true);
    expect(children.every((c) => c.parentItemId === parent.id)).toBe(true);
    expect(children.every((c) => Number(c.lineTotal) === 0)).toBe(true);
    const quantities = Object.fromEntries(
      children.map((child) => [child.productItemId, child.quantity]),
    );
    // Per room: 1 + 1 tables, 2 wardrobes, 4 + 2 chairs; times 2 rooms.
    expect(quantities).toEqual({
      [tableId]: 4,
      [wardrobeId]: 4,
      [chairId]: 12,
    });
  });

  it('refuses a combo that contains itself', async () => {
    const before = await orderCount();
    await expect(
      create(base({ items: [{ productItemId: loopAId, quantity: 1 }] })),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_COMBO_INVALID },
    });
    expect(await orderCount()).toBe(before);
  });

  it('refuses a combo with no components', async () => {
    await expect(
      create(base({ items: [{ productItemId: emptyComboId, quantity: 1 }] })),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_COMBO_INVALID },
    });
  });

  it.each([
    [undefined, ErrorCode.ORDER_ASSIGNEE_REQUIRED],
    [inactiveId, ErrorCode.ORDER_ASSIGNEE_INVALID],
    [strangerId, ErrorCode.ORDER_ASSIGNEE_INVALID],
  ])('refuses person in charge %s with %s', async (assigneeId, code) => {
    await expect(create(base({ assigneeId }))).rejects.toMatchObject({
      response: { code },
    });
  });

  it('refuses to ship from a damaged-goods warehouse', async () => {
    await expect(
      create(
        base({
          items: [
            { productItemId: sofaId, quantity: 1, sourceLocationId: damagedId },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.LOCATION_NOT_SELLABLE },
    });
  });

  it('refuses a ship-from location of another tenant', async () => {
    await expect(
      create(
        base({
          items: [
            {
              productItemId: sofaId,
              quantity: 1,
              sourceLocationId: randomUUID(),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_SOURCE_LOCATION_INVALID },
    });
  });

  it('refuses an order for a branch the account is not posted at', async () => {
    await expect(create(base(), staffElsewhere)).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_BRANCH_DENIED },
    });
  });

  it('creates a typed-in customer once and reuses them by phone', async () => {
    const customer = {
      name: 'Chị Lan',
      phone: '0912 345 678',
      address: '1 Lê Lợi',
    };
    const first = await create(base({ customerId: undefined, customer }));
    const second = await create(
      base({
        customerId: undefined,
        customer: { name: 'Lan', phone: '0912345678' },
      }),
    );
    const [a, b] = await prisma.order.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { customerId: true },
    });
    expect(a.customerId).toBe(b.customerId);
    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: a.customerId },
    });
    expect(row).toMatchObject({ name: 'Chị Lan', phone: '0912345678' });
    expect(row.customerCode).toMatch(/^KH\d{6}$/);
  });

  it("keeps the till's PATCH /orders/:id/status off a journey order", async () => {
    const order = await create(base());
    await expect(
      orders.updateStatus(owner, tenantId, order.id, OrderStatus.RETURNED),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID },
    });
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe(OrderStatus.CONFIRMED);
  });
});
