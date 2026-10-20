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
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';
import type { CreateOrderDto } from './../src/modules/orders/dto/create-order.dto';
import type { OrderItemCustomizationDto } from './../src/modules/orders/dto/order-item-customization.dto';

/**
 * Dòng custom (A-4, OrderCustomizationService – `PUT /orders/:id/items/:itemId/customization`, và
 * `customization` khi tạo đơn) trên Postgres thật (docker compose up -d): lần đầu tạo ProductItem
 * riêng cùng sản phẩm (kích thước, chi tiết, ảnh, kiện), lần sau sửa đúng item đó; chặn dòng combo,
 * đơn đã đóng gói, dòng đã có YCSX gửi xưởng; YCSX nháp chuyển theo item mới. Tự tạo tenant riêng và
 * dọn sạch.
 */
describe('PUT /orders/:id/items/:itemId/customization – OrderCustomizationService', () => {
  let prisma: PrismaService;
  let manual: ManualOrderService;
  let customizations: OrderCustomizationService;
  let fulfillments: FulfillmentService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const productId = randomUUID();
  const sofaId = randomUUID();
  const tableId = randomUUID();
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
        items: [{ productItemId: sofaId, quantity: 1 }],
        ...over,
      })
    ).id;

  const customize = (
    orderId: string,
    itemId: string,
    dto: OrderItemCustomizationDto,
  ) => customizations.customize(owner, tenantId, orderId, itemId, dto);

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { getResponse(): { code: string } }).getResponse().code;
    }
    return undefined;
  };

  const lineOf = async (orderId: string, productItemId?: string) =>
    prisma.orderItem.findFirstOrThrow({
      where: {
        orderId,
        parentItemId: null,
        ...(productItemId ? { productItemId } : {}),
      },
    });

  const itemOf = (id: string) =>
    prisma.productItem.findUniqueOrThrow({
      where: { id },
      include: {
        details: { orderBy: { position: 'asc' } },
        images: { orderBy: { position: 'asc' } },
        packages: { orderBy: { position: 'asc' } },
      },
    });

  const sofaSpecs: OrderItemCustomizationDto = {
    lengthCm: 181,
    widthCm: 90,
    material: 'Gỗ óc chó',
    fabricCode: 'V-102',
    note: 'Khách muốn tay vịn thấp',
    attachmentUrls: ['https://cdn.example.com/ban-ve-1.png'],
    specs: [{ name: 'Chiều cao lưng tựa', value: '95', unit: 'cm' }],
  };

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
    customizations = moduleRef.get(OrderCustomizationService);
    fulfillments = moduleRef.get(FulfillmentService);
    const inventory = moduleRef.get(InventoryService);

    await prisma.tenant.create({ data: { id: tenantId, name: 'custom-e2e' } });
    await prisma.user.create({
      data: {
        id: ownerId,
        tenantId,
        phoneNumber: `custom-${ownerId}`,
        systemRole: SystemRole.TENANT_OWNER,
        status: UserStatus.ACTIVE,
      },
    });
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
    for (const [id, name, price, itemType] of [
      [sofaId, 'Sofa', 10_000_000, 'PRODUCT'],
      [tableId, 'Bàn ăn', 2_000_000, 'PRODUCT'],
      [comboId, 'Combo phòng khách', 11_000_000, 'COMBO'],
    ] as const) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `CUS-${id}`,
          sku: `CUS-${id.slice(0, 8)}`,
          retailPrice: price,
          costPrice: 6_000_000,
          itemType,
          lengthCm: 180,
          widthCm: 85,
          heightCm: 80,
        },
      });
    }
    await prisma.productItemDetail.createMany({
      data: [
        {
          productItemId: sofaId,
          name: 'Chất liệu',
          value: 'Gỗ sồi',
          position: 0,
        },
        {
          productItemId: sofaId,
          name: 'Bảo hành',
          value: '24 tháng',
          position: 1,
        },
      ],
    });
    await prisma.productItemImage.create({
      data: {
        productItemId: sofaId,
        url: 'https://cdn.example.com/sofa.png',
        isThumbnail: true,
      },
    });
    await prisma.productPackage.createMany({
      data: [
        { productItemId: sofaId, position: 1, name: 'Khung' },
        { productItemId: sofaId, position: 2, name: 'Đệm' },
      ],
    });
    await prisma.comboComponent.createMany({
      data: [
        { comboItemId: comboId, componentItemId: sofaId, quantity: 1 },
        { comboItemId: comboId, componentItemId: tableId, quantity: 1 },
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
        quantity: 5,
        sourceType: LotSourceType.SUPPLIER,
        ledger: {
          type: InventoryTxType.IMPORT,
          referenceType: InventoryRefType.STOCK_MOVEMENT,
          referenceId: 'custom-e2e',
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
    await prisma.orderItemCustomization.deleteMany({ where: { tenantId } });
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

  it('moves a line to a ProductItem of its own, made to the specs', async () => {
    const orderId = await createOrder();
    const line = await lineOf(orderId);

    const detail = await customize(orderId, line.id, sofaSpecs);

    const after = await prisma.orderItem.findUniqueOrThrow({
      where: { id: line.id },
      include: { customization: { include: { specs: true } } },
    });
    expect(after.isCustom).toBe(true);
    expect(after.productItemId).not.toBe(sofaId);
    // Price and quantity are the order's; the line only changes what it is.
    expect(Number(after.unitPrice)).toBe(10_000_000);

    const custom = await itemOf(after.productItemId);
    expect(custom.productId).toBe(productId);
    expect(custom.sku).toMatch(new RegExp(`^CUS-${sofaId.slice(0, 8)}-C`));
    expect(after.sku).toBe(custom.sku);
    expect(Number(custom.retailPrice)).toBe(10_000_000);
    expect(Number(custom.lengthCm)).toBe(181);
    expect(Number(custom.widthCm)).toBe(90);
    // Not given: the catalogue's.
    expect(Number(custom.heightCm)).toBe(80);
    expect(custom.details.map((d) => [d.name, d.value])).toEqual([
      ['Bảo hành', '24 tháng'],
      ['Chất liệu', 'Gỗ óc chó'],
      ['Mã vải', 'V-102'],
      ['Chiều cao lưng tựa', '95 cm'],
    ]);
    expect(custom.images.map((i) => i.url)).toEqual([
      'https://cdn.example.com/sofa.png',
      'https://cdn.example.com/ban-ve-1.png',
    ]);
    expect(custom.packages.map((p) => p.name)).toEqual(['Khung', 'Đệm']);

    expect(after.customization).toMatchObject({
      material: 'Gỗ óc chó',
      fabricCode: 'V-102',
      note: 'Khách muốn tay vịn thấp',
      attachmentUrls: ['https://cdn.example.com/ban-ve-1.png'],
    });
    expect(after.customization!.specs).toHaveLength(1);
    expect(detail).toMatchObject({ id: orderId });

    // The catalogue SKU is untouched.
    const sofa = await itemOf(sofaId);
    expect(Number(sofa.lengthCm)).toBe(180);
    expect(sofa.details).toHaveLength(2);
  });

  it('rewrites the same custom item the second time, replacing only what the specs own', async () => {
    const orderId = await createOrder();
    const line = await lineOf(orderId);
    await customize(orderId, line.id, sofaSpecs);
    const customId = (await lineOf(orderId)).productItemId;
    const items = await prisma.productItem.count({ where: { tenantId } });

    await customize(orderId, line.id, {
      lengthCm: 200,
      color: 'Xám',
      attachmentUrls: ['https://cdn.example.com/ban-ve-2.png'],
      specs: [{ name: 'Số chỗ', value: '4' }],
    });

    expect(await prisma.productItem.count({ where: { tenantId } })).toBe(items);
    expect((await lineOf(orderId)).productItemId).toBe(customId);
    const custom = await itemOf(customId);
    expect(Number(custom.lengthCm)).toBe(200);
    expect(
      Object.fromEntries(custom.details.map((d) => [d.name, d.value])),
    ).toEqual({
      'Bảo hành': '24 tháng',
      'Màu sắc': 'Xám',
      'Số chỗ': '4',
    });
    expect(custom.images.map((i) => i.url)).toEqual([
      'https://cdn.example.com/sofa.png',
      'https://cdn.example.com/ban-ve-2.png',
    ]);
    const stored = await prisma.orderItemCustomization.findUniqueOrThrow({
      where: { orderItemId: line.id },
      include: { specs: true },
    });
    expect(stored.material).toBeNull();
    expect(stored.specs.map((s) => s.name)).toEqual(['Số chỗ']);
  });

  it('makes a line custom as the order is created', async () => {
    const orderId = await createOrder({
      items: [
        { productItemId: tableId, quantity: 1 },
        { productItemId: sofaId, quantity: 2, customization: sofaSpecs },
      ],
    });
    const table = await lineOf(orderId, tableId);
    expect(table.isCustom).toBe(false);
    const lines = await prisma.orderItem.findMany({
      where: { orderId, isCustom: true },
      include: { customization: true },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(2);
    expect(lines[0].customization?.fabricCode).toBe('V-102');
    expect(Number((await itemOf(lines[0].productItemId)).lengthCm)).toBe(181);
  });

  it('refuses to make a combo line to measure, on create or after', async () => {
    const orders = await prisma.order.count({ where: { tenantId } });
    expect(
      await codeOf(
        createOrder({
          items: [
            { productItemId: comboId, quantity: 1, customization: sofaSpecs },
          ],
        }),
      ),
    ).toBe(ErrorCode.ORDER_ITEM_NOT_CUSTOMIZABLE);
    expect(await prisma.order.count({ where: { tenantId } })).toBe(orders);

    const orderId = await createOrder({
      items: [{ productItemId: comboId, quantity: 1 }],
    });
    const combo = await lineOf(orderId, comboId);
    expect(await codeOf(customize(orderId, combo.id, sofaSpecs))).toBe(
      ErrorCode.ORDER_ITEM_NOT_CUSTOMIZABLE,
    );

    // A component of the combo carries goods, so it can be.
    const component = await prisma.orderItem.findFirstOrThrow({
      where: { orderId, parentItemId: combo.id, productItemId: sofaId },
    });
    await customize(orderId, component.id, sofaSpecs);
    expect(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: component.id },
        })
      ).isCustom,
    ).toBe(true);
  });

  it('refuses once the order is packed', async () => {
    const orderId = await createOrder();
    const line = await lineOf(orderId);
    await fulfillments.packOrder(owner, orderId, {});
    expect(await codeOf(customize(orderId, line.id, sofaSpecs))).toBe(
      ErrorCode.ORDER_NOT_EDITABLE,
    );
  });

  it('is fixed once a production request for the line is sent, and a draft one follows the new item', async () => {
    const sentOrder = await createOrder();
    const sentLine = await lineOf(sentOrder);
    await prisma.productionRequest.create({
      data: {
        tenantId,
        code: `YCSX-S-${sentOrder.slice(0, 6)}`,
        supplierId: workshopId,
        locationId: warehouseId,
        status: 'SENT',
        items: {
          create: {
            productItemId: sofaId,
            orderItemId: sentLine.id,
            quantity: 1,
          },
        },
      },
    });
    expect(await codeOf(customize(sentOrder, sentLine.id, sofaSpecs))).toBe(
      ErrorCode.ORDER_ITEM_CUSTOM_LOCKED,
    );

    const draftOrder = await createOrder();
    const draftLine = await lineOf(draftOrder);
    const request = await prisma.productionRequest.create({
      data: {
        tenantId,
        code: `YCSX-D-${draftOrder.slice(0, 6)}`,
        supplierId: workshopId,
        locationId: warehouseId,
        status: 'DRAFT',
        items: {
          create: {
            productItemId: sofaId,
            orderItemId: draftLine.id,
            quantity: 1,
          },
        },
      },
      include: { items: true },
    });
    await customize(draftOrder, draftLine.id, sofaSpecs);
    const customId = (await lineOf(draftOrder)).productItemId;
    const requestItem = await prisma.productionRequestItem.findUniqueOrThrow({
      where: { id: request.items[0].id },
    });
    expect(requestItem.productItemId).toBe(customId);
  });

  it('does not find a line of another order', async () => {
    const orderId = await createOrder();
    const other = await createOrder();
    const otherLine = await lineOf(other);
    expect(await codeOf(customize(orderId, otherLine.id, sofaSpecs))).toBe(
      ErrorCode.ORDER_ITEM_NOT_FOUND,
    );
  });
});
