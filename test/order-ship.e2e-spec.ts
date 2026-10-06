import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { FulfillmentService } from './../src/modules/fulfillments/fulfillments.service';
import { ShipmentService } from './../src/modules/shipments/shipments.service';
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
import {
  CarrierType,
  ShipmentStatus,
} from './../src/common/constants/shipment-status';
import { SystemRole } from './../src/common/constants/system-role';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/**
 * Kiểm thử lấy hàng & giao hàng (C-2, C-8) trên Postgres thật (docker compose up -d): "ĐVVC đã lấy
 * hàng" (POST /shipments), đổi shipper, và chuyển sang Đang vận chuyển – bước trừ tồn kho. Ai được
 * làm theo luật chốt 2026-10-06: chủ shop, người phụ trách đơn, hoặc người có quyền tại đúng kho.
 * Tự tạo tenant riêng và dọn sạch mọi thứ đã ghi, nên chạy lại bao nhiêu lần cũng được.
 */
describe('Shipments – POST /shipments, PATCH /shipments/:id/driver, POST /orders/:id/ship', () => {
  let prisma: PrismaService;
  let fulfillments: FulfillmentService;
  let shipments: ShipmentService;
  let inventory: InventoryService;
  const notify = jest.fn();

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const assigneeId = randomUUID(); // người phụ trách, không có role
  const storekeeperId = randomUUID(); // thủ kho ở kho, có quyền
  const driverId = randomUUID(); // shipper, role có shipments:deliver
  const outsiderId = randomUUID(); // STAFF không có role – không làm shipper được
  const roleId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
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

  /** Quyền của mọi bước giao hàng. */
  const SHIPPING_PERMISSIONS = [
    'shipments:create',
    'shipments:update',
    'orders:ship',
  ];

  /** Thủ kho đứng ở kho đóng gói, có đủ quyền. */
  const storekeeper = {
    ...owner,
    userId: storekeeperId,
    systemRole: SystemRole.STAFF,
    warehouseId,
    permissions: new Set(SHIPPING_PERMISSIONS),
  } as unknown as AuthUser;

  /** Cùng quyền nhưng đứng ở chi nhánh – không phải kho của đơn. */
  const managerAtBranch = {
    ...storekeeper,
    warehouseId: null,
    branchId,
  } as unknown as AuthUser;

  /** Người phụ trách: không quyền, đứng ở chi nhánh. */
  const assignee = {
    ...owner,
    userId: assigneeId,
    systemRole: SystemRole.STAFF,
    branchId,
  } as unknown as AuthUser;

  /** Shipper: role chỉ có shipments:deliver, đứng ở kho. */
  const driver = {
    ...owner,
    userId: driverId,
    systemRole: SystemRole.STAFF,
    warehouseId,
    permissions: new Set(['shipments:deliver']),
  } as unknown as AuthUser;

  /** Người chỉ có quyền xem, đứng ở `where`. */
  const reader = (where: { branchId?: string; warehouseId?: string }) =>
    ({
      ...owner,
      userId: outsiderId,
      systemRole: SystemRole.STAFF,
      branchId: where.branchId ?? null,
      warehouseId: where.warehouseId ?? null,
      permissions: new Set(['shipments:read']),
    }) as unknown as AuthUser;

  /** STAFF không quyền, không phụ trách, không giao gì. */
  const outsider = {
    ...owner,
    userId: outsiderId,
    systemRole: SystemRole.STAFF,
    warehouseId,
  } as unknown as AuthUser;

  /** Đơn CONFIRMED (tổng 1000 × số lượng, cọc 300) rồi đóng gói ở kho bằng tài khoản chủ. */
  async function packedOrder(quantity = 1, inCharge = assigneeId) {
    const id = randomUUID();
    await prisma.order.create({
      data: {
        id,
        code: `SHIP-${id}`,
        tenantId,
        branchId,
        customerId,
        userId: ownerId,
        assigneeId: inCharge,
        status: OrderStatus.CONFIRMED,
        grandTotal: 1000 * quantity,
        depositAmount: 300,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy, Hà Nội',
        items: {
          create: [
            {
              productItemId: tableId,
              sku: 'BAN-SHIP',
              quantity,
              listUnitPrice: 1000,
              unitPrice: 1000,
              lineTotal: 1000 * quantity,
              sourceLocationId: warehouseId,
            },
          ],
        },
      },
    });
    await fulfillments.packOrder(owner, id, {});
    return id;
  }

  const internal = (orderId: string, driver = driverId) => ({
    orderId,
    carrierType: CarrierType.INTERNAL,
    driverId: driver,
  });

  const tableStock = () =>
    prisma.inventory.findFirstOrThrow({
      where: { tenantId, locationId: warehouseId, productItemId: tableId },
    });

  const statusOf = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        InventoryService,
        FulfillmentService,
        ShipmentService,
        {
          provide: NotificationService,
          useValue: { managersOfLocation: () => Promise.resolve([]), notify },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    fulfillments = moduleRef.get(FulfillmentService);
    shipments = moduleRef.get(ShipmentService);
    inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'ship-e2e' } });
    await prisma.role.create({
      data: {
        id: roleId,
        tenantId,
        name: 'Shipper',
        permissions: { create: { resource: 'shipments', action: 'deliver' } },
      },
    });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `ship-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
      },
    });
    await prisma.user.createMany({
      data: [
        { id: assigneeId, roleId: null },
        { id: storekeeperId, roleId: null },
        { id: driverId, roleId },
        { id: outsiderId, roleId: null },
      ].map(({ id, roleId: role }) => ({
        id,
        tenantId,
        roleId: role,
        phoneNumber: `ship-${id}`,
        systemRole: SystemRole.STAFF,
      })),
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: 'CN ship', type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.location.create({
      data: { id: warehouseId, tenantId, name: 'Kho ship', type: 'WAREHOUSE' },
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
        productCode: `SHIP-${tableId}`,
        retailPrice: 1000,
        costPrice: 100,
      },
    });
    await prisma.customer.create({
      data: { id: customerId, tenantId, name: 'Khách' },
    });
    // 50 bàn ở kho (đủ cho mọi đơn các ca đóng gói), giá vốn lô 100.
    await prisma.$transaction((tx) =>
      inventory.openLot(tx, {
        tenantId,
        locationId: warehouseId,
        productItemId: tableId,
        quantity: 50,
        unitCost: 100,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'ship-e2e',
        },
      }),
    );
  });

  afterAll(async () => {
    await prisma.shipment.deleteMany({ where: { tenantId } }); // events: onDelete Cascade
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
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.role.deleteMany({ where: { tenantId } }); // role_permissions: onDelete Cascade
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  beforeEach(() => notify.mockClear());

  describe('POST /shipments – ĐVVC đã lấy hàng', () => {
    it('refuses an order that is not packed yet', async () => {
      const id = randomUUID();
      await prisma.order.create({
        data: {
          id,
          code: `SHIP-${id}`,
          tenantId,
          branchId,
          customerId,
          userId: ownerId,
          assigneeId,
          status: OrderStatus.CONFIRMED,
          grandTotal: 0,
        },
      });
      await expect(
        shipments.create(owner, tenantId, internal(id)),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_ORDER_NOT_PACKED },
      });
    });

    it('needs a driver for an internal delivery and refuses one for a carrier', async () => {
      const orderId = await packedOrder();
      await expect(
        shipments.create(owner, tenantId, {
          orderId,
          carrierType: CarrierType.INTERNAL,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_DRIVER_REQUIRED },
      });
      await expect(
        shipments.create(owner, tenantId, {
          orderId,
          carrierType: CarrierType.EXTERNAL,
          driverId,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_DRIVER_NOT_ALLOWED },
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.PACKED);
    });

    it('refuses a driver who is neither the owner, the person in charge, nor holds shipments:deliver', async () => {
      const orderId = await packedOrder();
      await expect(
        shipments.create(owner, tenantId, internal(orderId, outsiderId)),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_DRIVER_INVALID },
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.PACKED);
    });

    it('refuses a permission holder posted somewhere other than the packing location', async () => {
      const orderId = await packedOrder();
      await expect(
        shipments.create(managerAtBranch, tenantId, internal(orderId)),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });

    it('hands over: order PICKED_UP, fulfillment HANDED_OVER, shipment copies the recipient, stock still locked', async () => {
      const orderId = await packedOrder(2);
      const before = await tableStock();

      const shipment = await shipments.create(storekeeper, tenantId, {
        ...internal(orderId),
        scheduledDate: '2026-10-10',
        scheduledSlot: '08:00-12:00',
        shippingCost: 50000,
        note: 'gọi trước 30 phút',
      });

      expect(shipment).toMatchObject({
        status: ShipmentStatus.PICKED_UP,
        carrierType: CarrierType.INTERNAL,
        recipientName: 'Anh Nam',
        recipientPhone: '0912345678',
        deliveryAddress: '1 Cầu Giấy, Hà Nội',
        scheduledSlot: '08:00-12:00',
        shippingCost: 50000,
        order: {
          id: orderId,
          status: OrderStatus.PICKED_UP,
          customerName: 'Khách',
          amountDue: 1700, // 2000 − cọc 300
        },
        driver: { id: driverId },
      });
      expect(shipment.events).toHaveLength(1);
      expect(shipment.events[0]).toMatchObject({
        status: ShipmentStatus.PICKED_UP,
        createdBy: { id: storekeeperId },
      });

      const fulfillment = await prisma.fulfillment.findFirstOrThrow({
        where: { orderId },
      });
      expect(fulfillment.status).toBe(FulfillmentStatus.HANDED_OVER);
      expect(fulfillment.handedOverAt).not.toBeNull();
      // Lấy hàng không đụng tồn kho – hàng vẫn đang khoá.
      expect(await tableStock()).toMatchObject({
        stock: before.stock,
        lockedStock: before.lockedStock,
      });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIds: [driverId],
          type: 'SHIPMENT_ASSIGNED',
        }),
      );
    });

    it('creates one shipment when two people hand over the same order at once', async () => {
      const orderId = await packedOrder();
      const attempts = await Promise.allSettled([
        shipments.create(storekeeper, tenantId, internal(orderId)),
        shipments.create(owner, tenantId, internal(orderId)),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const loser = attempts.find((a) => a.status === 'rejected');
      expect([
        ErrorCode.ORDER_STATUS_CONFLICT,
        ErrorCode.SHIPMENT_ORDER_NOT_PACKED,
      ]).toContain(loser?.reason?.response?.code);
      expect(await prisma.shipment.count({ where: { orderId } })).toBe(1);
    });

    it('lets the person in charge hand over their own order with no permission, naming themselves as driver', async () => {
      const orderId = await packedOrder();
      const shipment = await shipments.create(
        assignee,
        tenantId,
        internal(orderId, assigneeId),
      );
      expect(shipment.driver).toMatchObject({ id: assigneeId });
      // Tự gán mình thì không tự báo cho mình.
      expect(notify).not.toHaveBeenCalled();
    });

    it('lets the shop owner be the driver', async () => {
      const orderId = await packedOrder();
      const shipment = await shipments.create(
        owner,
        tenantId,
        internal(orderId, ownerId),
      );
      expect(shipment.driver).toMatchObject({ id: ownerId });
    });

    it('refuses the person in charge of a different order', async () => {
      const orderId = await packedOrder(1, ownerId);
      await expect(
        shipments.create(assignee, tenantId, internal(orderId)),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });
  });

  describe('PATCH /shipments/:id/driver', () => {
    it('changes the driver and tells the new one', async () => {
      const orderId = await packedOrder();
      const created = await shipments.create(
        owner,
        tenantId,
        internal(orderId, ownerId),
      );
      notify.mockClear();

      const changed = await shipments.changeDriver(
        storekeeper,
        tenantId,
        created.id,
        { driverId },
      );
      expect(changed.driver).toMatchObject({ id: driverId });
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ recipientIds: [driverId] }),
      );
    });

    it('refuses an ineligible driver, a carrier shipment and a finished one', async () => {
      const orderId = await packedOrder();
      const created = await shipments.create(
        owner,
        tenantId,
        internal(orderId),
      );
      await expect(
        shipments.changeDriver(owner, tenantId, created.id, {
          driverId: outsiderId,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_DRIVER_INVALID },
      });

      await prisma.shipment.update({
        where: { id: created.id },
        data: { status: ShipmentStatus.DELIVERED },
      });
      await expect(
        shipments.changeDriver(owner, tenantId, created.id, {
          driverId: ownerId,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_STATUS_INVALID },
      });

      const carrierOrder = await packedOrder();
      const carrier = await shipments.create(owner, tenantId, {
        orderId: carrierOrder,
        carrierType: CarrierType.EXTERNAL,
        carrierName: 'GHN',
        trackingCode: `GHN-${carrierOrder}`,
      });
      await expect(
        shipments.changeDriver(owner, tenantId, carrier.id, { driverId }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_DRIVER_NOT_ALLOWED },
      });
    });

    it('refuses a tracking code already used with the same carrier', async () => {
      const first = await packedOrder();
      const second = await packedOrder();
      const trackingCode = `GHTK-${first}`;
      await shipments.create(owner, tenantId, {
        orderId: first,
        carrierType: CarrierType.EXTERNAL,
        carrierName: 'GHTK',
        trackingCode,
      });
      await expect(
        shipments.create(owner, tenantId, {
          orderId: second,
          carrierType: CarrierType.EXTERNAL,
          carrierName: 'GHTK',
          trackingCode,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_TRACKING_TAKEN },
      });
      expect(await statusOf(second)).toBe(OrderStatus.PACKED);
    });
  });

  describe('POST /orders/:id/ship – Đang vận chuyển', () => {
    it('refuses an order that has not been handed over', async () => {
      const orderId = await packedOrder();
      await expect(
        shipments.shipOrder(owner, tenantId, orderId, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID },
      });
    });

    it('refuses a permission holder posted somewhere other than the packing location', async () => {
      const orderId = await packedOrder();
      await shipments.create(owner, tenantId, internal(orderId));
      await expect(
        shipments.shipOrder(managerAtBranch, tenantId, orderId, {}),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.PICKED_UP);
    });

    it('ships: stock and lock both drop by the packed quantity, lines SHIPPED with their cost, shipment IN_TRANSIT', async () => {
      const orderId = await packedOrder(3);
      await shipments.create(owner, tenantId, internal(orderId));
      const before = await tableStock();

      const shipment = await shipments.shipOrder(
        storekeeper,
        tenantId,
        orderId,
        {
          note: 'xe đã chạy',
        },
      );

      expect(shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
      expect(shipment.order.status).toBe(OrderStatus.SHIPPING);
      expect(shipment.events.map((e) => e.status)).toEqual([
        ShipmentStatus.PICKED_UP,
        ShipmentStatus.IN_TRANSIT,
      ]);
      expect(await tableStock()).toMatchObject({
        stock: before.stock - 3,
        lockedStock: before.lockedStock - 3,
      });

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
      expect(order.shippedById).toBe(storekeeperId);
      expect(order.shippedAt).not.toBeNull();
      expect(order.items[0].status).toBe(OrderItemStatus.SHIPPED);
      expect(Number(order.items[0].unitCostPrice)).toBe(100);

      const sales = await prisma.inventoryTransaction.findMany({
        where: { tenantId, type: InventoryTxType.SALE, referenceId: orderId },
      });
      expect(sales.reduce((sum, row) => sum + row.quantity, 0)).toBe(-3);
      expect(sales.every((row) => row.orderItemId === order.items[0].id)).toBe(
        true,
      );
    });

    it('deducts once when the button is pressed twice at the same moment', async () => {
      const orderId = await packedOrder(2);
      await shipments.create(owner, tenantId, internal(orderId));
      const before = await tableStock();

      const attempts = await Promise.allSettled([
        shipments.shipOrder(owner, tenantId, orderId, {}),
        shipments.shipOrder(storekeeper, tenantId, orderId, {}),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const loser = attempts.find((a) => a.status === 'rejected');
      expect([
        ErrorCode.ORDER_STATUS_CONFLICT,
        ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
      ]).toContain(loser?.reason?.response?.code);
      expect(await tableStock()).toMatchObject({
        stock: before.stock - 2,
        lockedStock: before.lockedStock - 2,
      });
    });

    it('lets the person in charge ship their own order with no permission', async () => {
      const orderId = await packedOrder();
      await shipments.create(owner, tenantId, internal(orderId));
      const shipment = await shipments.shipOrder(
        assignee,
        tenantId,
        orderId,
        {},
      );
      expect(shipment.order.status).toBe(OrderStatus.SHIPPING);
    });
  });

  /** Đơn đã đóng gói, đã giao cho shipper `driverId`, đã chuyển Đang vận chuyển. */
  async function shippedShipment(inCharge = assigneeId) {
    const orderId = await packedOrder(1, inCharge);
    const created = await shipments.create(owner, tenantId, internal(orderId));
    await shipments.shipOrder(owner, tenantId, orderId, {});
    return { orderId, shipmentId: created.id };
  }

  describe('GET /shipments, GET /shipments/:id – ai xem được gì', () => {
    it('shows a shipment to the owner, the person in charge, the driver, and readers at the packing warehouse or the selling branch', async () => {
      const { shipmentId } = await shippedShipment();
      for (const viewer of [
        owner,
        assignee,
        driver,
        reader({ warehouseId }),
        reader({ branchId }),
      ]) {
        const found = await shipments.findOne(viewer, tenantId, shipmentId);
        expect(found.id).toBe(shipmentId);
        expect(found.events.length).toBeGreaterThan(0);
      }
    });

    it('hides it, as a 404, from a reader posted elsewhere and from someone with no tie to it', async () => {
      const { shipmentId } = await shippedShipment();
      for (const viewer of [reader({ branchId: randomUUID() }), outsider]) {
        await expect(
          shipments.findOne(viewer, tenantId, shipmentId),
        ).rejects.toMatchObject({
          response: { code: ErrorCode.SHIPMENT_NOT_FOUND },
        });
      }
      const elsewhere = await shipments.findAll(
        reader({ branchId: randomUUID() }),
        tenantId,
        { page: 1, limit: 100 },
      );
      expect(elsewhere.pagination.total).toBe(0);
    });

    it("lists only a driver's own shipments", async () => {
      await shippedShipment();
      const mine = await shipments.findAll(driver, tenantId, {
        page: 1,
        limit: 100,
      });
      expect(mine.data.length).toBeGreaterThan(0);
      expect(mine.data.every((row) => row.driver?.id === driverId)).toBe(true);
    });

    it('filters by status and searches by order code, and reads from/to as Vietnam calendar days', async () => {
      const { orderId, shipmentId } = await shippedShipment();
      const code = `SHIP-${orderId}`;
      const found = await shipments.findAll(owner, tenantId, {
        page: 1,
        limit: 10,
        status: ShipmentStatus.IN_TRANSIT,
        search: code,
      });
      expect(found.data.map((row) => row.id)).toEqual([shipmentId]);
      expect(found.data[0]).not.toHaveProperty('events');

      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(new Date());
      const yesterday = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const onToday = await shipments.findAll(owner, tenantId, {
        page: 1,
        limit: 10,
        search: code,
        from: today,
        to: today,
      });
      expect(onToday.pagination.total).toBe(1);
      const untilYesterday = await shipments.findAll(owner, tenantId, {
        page: 1,
        limit: 10,
        search: code,
        to: yesterday,
      });
      expect(untilYesterday.pagination.total).toBe(0);
    });
  });

  describe('POST /shipments/:id/events – nhật trình', () => {
    it('lets the driver log "out for delivery", moving the shipment along but not the order', async () => {
      const { orderId, shipmentId } = await shippedShipment();
      const shipment = await shipments.addEvent(driver, tenantId, shipmentId, {
        status: ShipmentStatus.OUT_FOR_DELIVERY,
        note: 'đang tới',
        latitude: 21.03,
        longitude: 105.8,
      });
      expect(shipment.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
      expect(shipment.events.at(-1)).toMatchObject({
        status: ShipmentStatus.OUT_FOR_DELIVERY,
        latitude: 21.03,
        longitude: 105.8,
        createdBy: { id: driverId },
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.SHIPPING);
    });

    it('refuses a shipment that is not on the road yet', async () => {
      const orderId = await packedOrder();
      const created = await shipments.create(
        owner,
        tenantId,
        internal(orderId),
      );
      await expect(
        shipments.addEvent(owner, tenantId, created.id, {
          status: ShipmentStatus.OUT_FOR_DELIVERY,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.SHIPMENT_STATUS_INVALID },
      });
    });

    it('refuses someone who is not the owner, in charge, the driver, or holding shipments:update there', async () => {
      const { shipmentId } = await shippedShipment();
      await expect(
        shipments.addEvent(outsider, tenantId, shipmentId, {
          status: ShipmentStatus.OUT_FOR_DELIVERY,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });

    it('stops a driver who has just been replaced', async () => {
      const { shipmentId } = await shippedShipment();
      await shipments.changeDriver(owner, tenantId, shipmentId, {
        driverId: ownerId,
      });
      await expect(
        shipments.addEvent(driver, tenantId, shipmentId, {
          status: ShipmentStatus.OUT_FOR_DELIVERY,
        }),
      ).rejects.toMatchObject({
        response: { code: ErrorCode.ORDER_STEP_DENIED },
      });
    });
  });

  describe('POST /shipments/:id/fail – giao không thành', () => {
    it('marks the shipment FAILED, keeps the order SHIPPING, and tells the person in charge', async () => {
      const { orderId, shipmentId } = await shippedShipment();
      notify.mockClear();
      const shipment = await shipments.fail(driver, tenantId, shipmentId, {
        note: 'khách không nghe máy',
      });
      expect(shipment.status).toBe(ShipmentStatus.FAILED);
      expect(shipment.events.at(-1)).toMatchObject({
        status: ShipmentStatus.FAILED,
        note: 'khách không nghe máy',
      });
      expect(await statusOf(orderId)).toBe(OrderStatus.SHIPPING);
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientIds: [assigneeId],
          type: 'SHIPMENT_FAILED',
        }),
      );
    });

    it('fails once when two people report it at the same moment', async () => {
      const { shipmentId } = await shippedShipment();
      const attempts = await Promise.allSettled([
        shipments.fail(driver, tenantId, shipmentId, { note: 'a' }),
        shipments.fail(owner, tenantId, shipmentId, { note: 'b' }),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const loser = attempts.find((a) => a.status === 'rejected');
      expect(loser?.reason?.response?.code).toBe(
        ErrorCode.SHIPMENT_STATUS_INVALID,
      );
      const failedEvents = await prisma.shipmentEvent.count({
        where: { shipmentId, status: ShipmentStatus.FAILED },
      });
      expect(failedEvents).toBe(1);
    });
  });
});
