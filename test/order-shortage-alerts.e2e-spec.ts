import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { OrderService } from './../src/modules/orders/orders.service';
import { OrderPricingService } from './../src/modules/orders/order-pricing.service';
import { ManualOrderService } from './../src/modules/orders/manual-order.service';
import { OrderCustomizationService } from './../src/modules/orders/order-customization.service';
import { OrderShortageAlerts } from './../src/modules/orders/order-shortage-alerts';
import { OrderEditService } from './../src/modules/orders/order-edit.service';
import { OrderReadService } from './../src/modules/orders/order-read.service';
import { SepayOrderService } from './../src/modules/orders/sepay-order.service';
import { ProductionListService } from './../src/modules/production-requests/production-list.service';
import { CustomerService } from './../src/modules/customers/customers.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import type { AuthUser } from './../src/common/types/auth-user.type';
import type { CreateOrderDto } from './../src/modules/orders/dto/create-order.dto';

type NotifyArgs = {
  type: string;
  recipientIds: string[];
  referenceId: string;
};

/**
 * Cảnh báo thiếu hàng phía đơn (B-3, OrderShortageAlerts) trên Postgres thật (docker compose up -d):
 * tạo đơn / sửa dòng / làm dòng custom làm một dòng của danh sách cần sản xuất chuyển từ đủ sang
 * thiếu thì báo người quản lý nơi xuất – một lần, lúc chuyển; dòng vốn đã thiếu thì không báo lại;
 * và cảnh báo hỏng không làm hỏng đơn. Tự tạo tenant riêng và dọn sạch.
 */
describe('Shortage alerts from order writes – OrderShortageAlerts', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let edits: OrderEditService;
  let customizations: OrderCustomizationService;
  const notify = jest.fn<Promise<void>, [NotifyArgs]>();

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const managerId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const tableId = randomUUID();
  const customerId = randomUUID();

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
        items: [{ productItemId: sofaId, quantity: 1 }],
        ...over,
      })
    ).id;

  /** The shortage alerts sent since the last reset, as (SKU, recipients). */
  const shortageAlerts = () =>
    notify.mock.calls
      .map(([args]) => args)
      .filter((args) => args.type === 'PRODUCTION_SHORTAGE');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
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
        {
          provide: NotificationService,
          useValue: {
            managersOfLocation: () => Promise.resolve([managerId]),
            notify,
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
    customizations = moduleRef.get(OrderCustomizationService);
    const inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'short-e2e' } });
    for (const [id, role] of [
      [ownerId, SystemRole.TENANT_OWNER],
      [managerId, SystemRole.STAFF],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          tenantId,
          phoneNumber: `short-${id}`,
          systemRole: role,
          status: UserStatus.ACTIVE,
        },
      });
    }
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho', type: 'WAREHOUSE' },
    });
    await prisma.warehouse.create({
      data: { id: warehouseId, tenantId, locationId: warehouseId },
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
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    for (const [id, name] of [
      [sofaId, 'Sofa'],
      [tableId, 'Bàn'],
    ] as const) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `SHORT-${id}`,
          sku: `SHORT-${id.slice(0, 8)}`,
          retailPrice: 5_000_000,
          costPrice: 3_000_000,
        },
      });
    }
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    // Sofa: 3 on the shelf. Table: none.
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: sofaId,
        quantity: 3,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'short-e2e',
        },
      }),
    );
  });

  beforeEach(() => {
    notify.mockReset();
    notify.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItemCustomization.deleteMany({ where: { tenantId } });
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
      data: { defaultFulfillmentLocationId: null },
    });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  // Order matters: each test leaves demand on the list for the next.

  it('says nothing while the shelf covers the order', async () => {
    await createOrder({ items: [{ productItemId: sofaId, quantity: 2 }] });
    expect(shortageAlerts()).toEqual([]);
  });

  it('tells the location’s managers when an order tips a SKU to short', async () => {
    await createOrder({ items: [{ productItemId: sofaId, quantity: 2 }] });
    const alerts = shortageAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      referenceId: sofaId,
      recipientIds: [managerId],
    });
  });

  it('does not repeat itself for a SKU already short', async () => {
    await createOrder({ items: [{ productItemId: sofaId, quantity: 1 }] });
    expect(shortageAlerts()).toEqual([]);
  });

  it('fires when an edit of the lines tips a SKU to short', async () => {
    const id = await createOrder({
      items: [{ productItemId: tableId, quantity: 1 }],
    });
    // Table: no stock at all, so the create itself tipped it.
    expect(shortageAlerts().map((a) => a.referenceId)).toEqual([tableId]);
    notify.mockReset();

    // Back to sofa only: no new shortage (sofa was short already).
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });
    await edits.update(owner, tenantId, id, {
      items: [{ id: line.id, productItemId: tableId, quantity: 4 }],
    });
    expect(shortageAlerts()).toEqual([]);
  });

  it('fires for a line made to measure, which moves to a SKU with no stock', async () => {
    // A fresh SKU: the create tips it short; making the line custom moves the demand to a new SKU, short in turn.
    const benchId = randomUUID();
    await prisma.productItem.create({
      data: {
        id: benchId,
        tenantId,
        productId,
        productName: 'Ghế dài',
        productCode: `SHORT-${benchId}`,
        sku: `SHORT-${benchId.slice(0, 8)}`,
        retailPrice: 2_000_000,
        costPrice: 1_000_000,
      },
    });
    const id = await createOrder({
      items: [{ productItemId: benchId, quantity: 1 }],
    });
    notify.mockReset();

    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });
    await customizations.customize(owner, tenantId, id, line.id, {
      lengthCm: 150,
    });
    const custom = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
    });
    expect(shortageAlerts().map((a) => a.referenceId)).toEqual([
      custom.productItemId,
    ]);
  });

  it('never fails the order when the alert does', async () => {
    notify.mockRejectedValue(new Error('push down'));
    const id = await createOrder({
      items: [{ productItemId: tableId, quantity: 50 }],
    });
    expect(await prisma.order.count({ where: { id } })).toBe(1);
  });
});
