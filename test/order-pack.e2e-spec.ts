import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import {
  InventoryRefType,
  InventoryTxType,
  LotSourceType,
} from './../src/common/constants/inventory-ledger';
import {
  OrderItemStatus,
  OrderStatus,
} from './../src/common/constants/order-status';
import { FulfillmentStatus } from './../src/common/constants/fulfillment-status';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Kiểm thử đóng đơn (C-1, FulfillmentService.packOrder) trên Postgres thật (docker compose up -d):
 * khoá hàng, chặn khi trên kệ thiếu, và hai kiểu bấm cùng lúc (race condition). Tự tạo tenant
 * riêng và dọn sạch mọi thứ đã ghi, nên chạy lại bao nhiêu lần cũng được.
 */
describe('POST /orders/:id/pack – FulfillmentService.packOrder', () => {
  let prisma: PrismaService;
  let fulfillments: FulfillmentService;
  let inventory: InventoryService;
  const notify = jest.fn();

  const tenantId = randomUUID();
  const userId = randomUUID();
  const staffId = randomUUID();
  const assigneeId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const wardrobeId = randomUUID(); // SKU khai báo 2 kiện
  const tableId = randomUUID(); // SKU không khai báo kiện, chưa từng có ở kho
  const customerId = randomUUID();

  /** Chủ shop – đóng gói ở kho nào cũng được. */
  const owner = {
    userId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  /** Nhân viên có quyền `orders:pack` nhưng được phân công ở chi nhánh, không phải kho đóng gói. */
  const staffAtBranch = {
    ...owner,
    userId: staffId,
    systemRole: SystemRole.STAFF,
    branchId,
    permissions: new Set(['orders:pack']),
  } as unknown as AuthUser;

  /** Người phụ trách đơn: không có quyền nào trong role, đứng ở chi nhánh – vẫn đóng được đơn của mình. */
  const assigneeAtBranch = {
    ...staffAtBranch,
    userId: assigneeId,
    permissions: new Set<string>(),
  } as unknown as AuthUser;

  /** Tạo một đơn CONFIRMED với các dòng cho trước (bỏ trống `sourceLocationId` = xuất từ kho; `null` = chưa có kho xuất). Người phụ trách mặc định là chủ shop. */
  async function createOrder(
    lines: {
      productItemId: string;
      quantity: number;
      sourceLocationId?: string | null;
    }[],
    inCharge = userId,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `PACK-${id}`,
        tenantId,
        branchId,
        customerId,
        userId,
        assigneeId: inCharge,
        status: OrderStatus.CONFIRMED,
        grandTotal: 0,
        items: {
          create: lines.map((line) => ({
            productItemId: line.productItemId,
            sku: line.productItemId === wardrobeId ? 'TU-2K' : 'BAN-1K',
            quantity: line.quantity,
            listUnitPrice: 1000,
            unitPrice: 1000,
            lineTotal: 1000 * line.quantity,
            sourceLocationId:
              line.sourceLocationId === undefined
                ? warehouseId
                : line.sourceLocationId,
          })),
        },
      },
    });
    return id;
  }

  /** Dòng tồn của tủ tại kho đóng gói. */
  const wardrobeStock = () =>
    prisma.inventory.findFirstOrThrow({
      where: { tenantId, locationId: warehouseId, productItemId: wardrobeId },
    });

  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        InventoryService,
        FulfillmentService,
        {
          provide: NotificationService,
          useValue: { managersOfLocation: () => Promise.resolve([]), notify },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    fulfillments = moduleRef.get(FulfillmentService);
    inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'pack-e2e' } });
    await prisma.user.create({
      data: {
        id: userId,
        tenantId,
        phoneNumber: `pack-${userId}`,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.user.createMany({
      data: [staffId, assigneeId].map((id) => ({
        id,
        tenantId,
        phoneNumber: `pack-${id}`,
        systemRole: SystemRole.STAFF,
      })),
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN pack', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho pack', type: 'WAREHOUSE' },
    });
    await prisma.product.create({
      data: { id: productId, tenantId, name: 'Nội thất' },
    });
    for (const [id, name] of [
      [wardrobeId, 'Tủ 2 kiện'],
      [tableId, 'Bàn'],
    ]) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `PACK-${id}`,
          retailPrice: 1000,
          costPrice: 50,
        },
      });
    }
    await prisma.productPackage.createMany({
      data: [
        { productItemId: wardrobeId, position: 1 },
        { productItemId: wardrobeId, position: 2 },
      ],
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });

    // 5 tủ ở kho, cảnh báo khi trên kệ còn <= 2.
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: wardrobeId,
        quantity: 5,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'pack-e2e',
        },
      }),
    );
    await prisma.inventory.updateMany({
      where: { tenantId, productItemId: wardrobeId },
      data: { minStock: 2 },
    });
  });

  afterAll(async () => {
    await prisma.fulfillmentPackage.deleteMany({ where: { tenantId } });
    await prisma.fulfillmentItem.deleteMany({
      where: { fulfillment: { tenantId } },
    });
    await prisma.fulfillment.deleteMany({ where: { tenantId } });
    await prisma.inventoryTransaction.deleteMany({ where: { tenantId } });
    await prisma.inventoryLot.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.inventory.deleteMany({ where: { tenantId } });
    await prisma.productPackage.deleteMany({
      where: { productItemId: { in: [wardrobeId, tableId] } },
    });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('refuses a permission holder posted somewhere other than the packing location', async () => {
    const orderId = await createOrder([
      { productItemId: wardrobeId, quantity: 1 },
    ]);
    await expect(
      fulfillments.packOrder(staffAtBranch, orderId, {}),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_STEP_DENIED },
    });
    expect(await statusOf(orderId)).toBe(OrderStatus.CONFIRMED);
  });

  it('refuses an order whose lines ship from more than one location', async () => {
    const orderId = await createOrder([
      { productItemId: wardrobeId, quantity: 1 },
      { productItemId: tableId, quantity: 1, sourceLocationId: branchId },
    ]);
    await expect(
      fulfillments.packOrder(owner, orderId, {}),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FULFILLMENT_MULTIPLE_SOURCES },
    });
    expect(await statusOf(orderId)).toBe(OrderStatus.CONFIRMED);
  });

  it('refuses an order with a line that has no location to ship from', async () => {
    const orderId = await createOrder([
      { productItemId: wardrobeId, quantity: 1 },
      { productItemId: tableId, quantity: 1, sourceLocationId: null },
    ]);
    await expect(
      fulfillments.packOrder(owner, orderId, {}),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.FULFILLMENT_LINE_NO_SOURCE },
    });
    expect(await statusOf(orderId)).toBe(OrderStatus.CONFIRMED);
  });

  let packedOrderId = '';

  it("packs as the order's person in charge - no permission, posted elsewhere: order PACKED, one box per declared package per unit, stock locked but not deducted", async () => {
    packedOrderId = await createOrder(
      [{ productItemId: wardrobeId, quantity: 2 }],
      assigneeId,
    );
    const ledgerBefore = await prisma.inventoryTransaction.count({
      where: { tenantId },
    });

    const packed = await fulfillments.packOrder(
      assigneeAtBranch,
      packedOrderId,
      { note: 'thùng 2 móp góc' },
    );

    expect(packed).toMatchObject({
      status: FulfillmentStatus.PACKED,
      locationId: warehouseId,
      verifiedById: assigneeId,
      exceptionNote: 'thùng 2 móp góc',
    });
    expect(packed.items).toHaveLength(1);
    expect(packed.items[0]).toMatchObject({
      quantity: 2,
      qtyPicked: 2,
      qtyPacked: 2,
    });
    expect(packed.packages).toHaveLength(4); // 2 tủ × 2 kiện
    expect(packed.packages.every((box) => box.code.startsWith('PK'))).toBe(
      true,
    );

    expect(await statusOf(packedOrderId)).toBe(OrderStatus.PACKED);
    // Dòng đơn chỉ đổi trạng thái lúc ship.
    const line = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: packedOrderId },
    });
    expect(line.status).toBe(OrderItemStatus.PENDING);
    // Khoá chứ không trừ: stock giữ nguyên, không ghi sổ kho.
    expect(await wardrobeStock()).toMatchObject({ stock: 5, lockedStock: 2 });
    expect(
      await prisma.inventoryTransaction.count({ where: { tenantId } }),
    ).toBe(ledgerBefore);
    // Trên kệ 5 → 3, chưa chạm ngưỡng 2.
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses to pack an order that is no longer CONFIRMED', async () => {
    await expect(
      fulfillments.packOrder(owner, packedOrderId, {}),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID },
    });
  });

  it('packs one order once when the button is pressed twice at the same moment', async () => {
    const orderId = await createOrder([
      { productItemId: wardrobeId, quantity: 1 },
    ]);
    const attempts = await Promise.allSettled([
      fulfillments.packOrder(owner, orderId, {}),
      fulfillments.packOrder(owner, orderId, {}),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const loser = attempts.find((a) => a.status === 'rejected');
    // Thua ở bước "nhận đơn" trong transaction, hoặc ở bước kiểm tra sớm nếu tới sau khi bên kia đã commit.
    expect([
      ErrorCode.ORDER_STATUS_CONFLICT,
      ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
    ]).toContain(loser?.reason?.response?.code);
    expect(await prisma.fulfillment.count({ where: { orderId } })).toBe(1);
    expect(await wardrobeStock()).toMatchObject({ stock: 5, lockedStock: 3 });
  });

  it('warns when packing takes the shelf down to the threshold', () => {
    // Trên kệ 3 → 2 = minStock: cảnh báo một lần, sau commit.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('lets only one of two orders racing for the last pieces lock them', async () => {
    const [first, second] = await Promise.all([
      createOrder([{ productItemId: wardrobeId, quantity: 2 }]),
      createOrder([{ productItemId: wardrobeId, quantity: 2 }]),
    ]);
    const attempts = await Promise.allSettled([
      fulfillments.packOrder(owner, first, {}),
      fulfillments.packOrder(owner, second, {}),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const loser = attempts.find((a) => a.status === 'rejected');
    expect(loser?.reason?.response?.code).toBe(ErrorCode.INSUFFICIENT_STOCK);
    // Trên kệ còn đúng 2 – khoá hết, không bao giờ vượt tổng.
    expect(await wardrobeStock()).toMatchObject({ stock: 5, lockedStock: 5 });
    // Đơn thua quay về nguyên trạng: vẫn CONFIRMED, không có fulfillment, không thùng nào.
    const statuses = [await statusOf(first), await statusOf(second)].sort();
    expect(statuses).toEqual([OrderStatus.CONFIRMED, OrderStatus.PACKED]);
    expect(
      await prisma.fulfillment.count({
        where: { orderId: { in: [first, second] } },
      }),
    ).toBe(1);
    // Trên kệ đã ở dưới ngưỡng từ trước: không cảnh báo lại (edge-triggered).
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('names every short line and locks none of them when the shelf cannot cover the order', async () => {
    const orderId = await createOrder([
      { productItemId: wardrobeId, quantity: 1 },
      { productItemId: tableId, quantity: 1 },
    ]);
    await expect(
      fulfillments.packOrder(owner, orderId, {}),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.INSUFFICIENT_STOCK,
        message: expect.stringMatching(/TU-2K.*BAN-1K/),
        // Chi tiết có cấu trúc cho màn Đóng hàng. Tủ đã khoá hết 5/5, bàn chưa từng có ở kho.
        errors: [
          { label: 'TU-2K', needed: 1, onShelf: 0 },
          { label: 'BAN-1K', needed: 1, onShelf: 0 },
        ],
      },
    });
    expect(await statusOf(orderId)).toBe(OrderStatus.CONFIRMED);
    expect(await prisma.fulfillment.count({ where: { orderId } })).toBe(0);
    expect(await wardrobeStock()).toMatchObject({ stock: 5, lockedStock: 5 });
  });
});
