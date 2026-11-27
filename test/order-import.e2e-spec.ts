import 'dotenv/config';
import { randomUUID } from 'crypto';
import * as ExcelJS from 'exceljs';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { InvoiceService } from './../src/modules/invoices/invoices.service';
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
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { PromotionService } from './../src/modules/promotions/promotions.service';
import { RealtimeGateway } from './../src/common/realtime/realtime.gateway';
import { OrderImportService } from './../src/modules/orders/import/order-import.service';
import {
  ORDER_IMPORT_COLUMNS,
  ORDER_IMPORT_SHEET,
  orderHeaderLabel,
} from './../src/modules/orders/import/order-import.columns';
import type { OrderImportColumnKey } from './../src/modules/orders/import/order-import.columns';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import { ErrorCode } from './../src/common/errors/error-codes';
import type { AuthUser } from './../src/common/types/auth-user.type';

/** Nhập đơn từ Excel (Postgres thật): file mẫu, cả file đúng mới tạo, mỗi đơn qua đúng bước của POST /orders. */
describe('POST /orders/import – OrderImportService', () => {
  let prisma: PrismaService;
  let importer: OrderImportService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID(); // ở CN Hà Nội
  const otherStaffId = randomUUID(); // ở CN 2
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const productId = randomUUID();
  const tableId = randomUUID(); // 2.000.000
  const chairId = randomUUID(); // 500.000
  const suffix = tenantId.slice(0, 6);
  const staffPhone = `09${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const customerPhone = `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;
  const staffElsewhere = {
    ...owner,
    userId: otherStaffId,
    systemRole: SystemRole.STAFF,
    branchId: otherBranchId,
  } as unknown as AuthUser;

  /** File .xlsx đúng tiêu đề file mẫu, mỗi phần tử một dòng. */
  async function fileOf(
    rows: Partial<Record<OrderImportColumnKey, string | number>>[],
    headers = ORDER_IMPORT_COLUMNS.map(orderHeaderLabel),
  ): Promise<Express.Multer.File> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(ORDER_IMPORT_SHEET);
    sheet.addRow(headers);
    for (const row of rows) {
      sheet.addRow(ORDER_IMPORT_COLUMNS.map((c) => row[c.key] ?? null));
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      size: buffer.length,
      originalname: 'don-hang.xlsx',
    } as Express.Multer.File;
  }

  const orderCount = () => prisma.order.count({ where: { tenantId } });
  const assignee = `Nhân viên ${suffix} - ${staffPhone}`;

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
        OrderImportService,
        { provide: InventoryService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
        { provide: PromotionService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    importer = moduleRef.get(OrderImportService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'order-import-e2e' },
    });
    await prisma.location.createMany({
      data: [
        { id: branchId, tenantId, name: `CN Hà Nội ${suffix}`, type: 'BRANCH' },
        { id: otherBranchId, tenantId, name: `CN 2 ${suffix}`, type: 'BRANCH' },
      ],
    });
    await prisma.branch.createMany({
      data: [
        { id: branchId, tenantId, locationId: branchId },
        { id: otherBranchId, tenantId, locationId: otherBranchId },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: `oi-${ownerId}`,
          systemRole: SystemRole.TENANT_OWNER,
          status: UserStatus.ACTIVE,
        },
        {
          id: staffId,
          tenantId,
          phoneNumber: staffPhone,
          profileLastName: 'Nhân viên',
          profileFirstName: suffix,
          systemRole: SystemRole.STAFF,
          status: UserStatus.ACTIVE,
          locationId: branchId,
        },
        {
          id: otherStaffId,
          tenantId,
          phoneNumber: `oi-${otherStaffId}`,
          systemRole: SystemRole.STAFF,
          status: UserStatus.ACTIVE,
          locationId: otherBranchId,
        },
      ],
    });
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Nội thất',
        isManufacturable: true,
      },
    });
    for (const [id, name, price] of [
      [tableId, 'Bàn', 2_000_000],
      [chairId, 'Ghế', 500_000],
    ] as const) {
      await prisma.productItem.create({
        data: {
          id,
          tenantId,
          productId,
          productName: name,
          productCode: `OI-${id}`,
          sku: `OI-${id.slice(0, 8)}`,
          retailPrice: price,
          costPrice: 0,
          itemType: 'PRODUCT',
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderEvent.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  const table = () => `OI-${tableId.slice(0, 8)}`;
  const chair = () => `OI-${chairId.slice(0, 8)}`;

  it('builds a template whose lists come from the shop', async () => {
    const buffer = await importer.buildTemplate(owner, tenantId);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet(ORDER_IMPORT_SHEET)!;
    expect(sheet.getCell(1, 1).value).toBe('Mã nhóm đơn (*)');
    const lists = workbook.getWorksheet('Danh sách')!;
    const values = lists.getColumn(1).values.filter(Boolean);
    expect(values).toEqual(
      expect.arrayContaining([`CN Hà Nội ${suffix}`, `CN 2 ${suffix}`]),
    );
    expect(lists.getColumn(2).values).toContain(assignee);

    // Đơn mẫu dựng bằng dữ liệu của cửa hàng: chi nhánh đầu (theo tên), người phụ trách làm ở đó, SKU đang bán.
    const cell = (row: number, key: OrderImportColumnKey) =>
      sheet
        .getRow(row)
        .getCell(ORDER_IMPORT_COLUMNS.findIndex((c) => c.key === key) + 1)
        .value;
    expect(cell(2, 'group')).toBe('MẪU-1');
    expect(cell(2, 'branch')).toBe(`CN 2 ${suffix}`);
    expect(cell(2, 'sku')).toBe(chair());
    expect(cell(4, 'group')).toBe('MẪU-2');

    // Nhập nguyên file mẫu: các dòng mẫu bị từ chối, không có đơn nào được tạo.
    const before = await orderCount();
    await expect(
      importer.import(owner, tenantId, {
        buffer,
        size: buffer.length,
        originalname: 'mau.xlsx',
      } as Express.Multer.File),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_IMPORT_ROWS_INVALID, errorCount: 3 },
    });
    expect(await orderCount()).toBe(before);
  });

  it('creates every order of a correct file, with a new customer and a deposit in the cash book', async () => {
    const before = await orderCount();
    const result = await importer.import(
      owner,
      tenantId,
      await fileOf([
        {
          group: 'DH1',
          branch: `CN Hà Nội ${suffix}`,
          fulfillmentType: 'Giao tận nơi',
          assignee,
          customerPhone,
          customerName: 'Khách nhập file',
          deliveryAddress: '12 Láng Hạ',
          shippingFee: 50000,
          deposit: 1_000_000,
          depositMethod: 'Tiền mặt',
          sku: table(),
          quantity: 1,
        },
        { group: 'DH1', sku: chair(), quantity: 2, unitPrice: 400000 },
        {
          group: 'DH2',
          branch: `CN Hà Nội ${suffix}`,
          fulfillmentType: 'Khách đến lấy',
          assignee: staffPhone,
          sku: chair(),
          quantity: 1,
        },
      ]),
    );
    expect(result.data.orderCount).toBe(2);
    expect(await orderCount()).toBe(before + 2);

    const [first, second] = await Promise.all(
      result.data.orderIds.map((id) =>
        prisma.order.findUniqueOrThrow({
          where: { id },
          include: { items: true, customer: true },
        }),
      ),
    );
    expect(first).toMatchObject({
      status: 'CONFIRMED',
      branchId,
      assigneeId: staffId,
      sellerId: ownerId,
      fulfillmentType: 'HOME_DELIVERY',
      recipientName: 'Khách nhập file',
      deliveryAddress: '12 Láng Hạ',
    });
    // 2.000.000 + 2 × 400.000 + 50.000 phí giao.
    expect(Number(first.grandTotal)).toBe(2_850_000);
    expect(first.items).toHaveLength(2);
    expect(first.customer?.name).toBe('Khách nhập file');
    expect(second).toMatchObject({ fulfillmentType: 'STORE_PICKUP' });
    expect(Number(second.grandTotal)).toBe(500_000);

    const deposit = await prisma.cashFlow.findFirstOrThrow({
      where: { tenantId, orderId: first.id },
      select: { category: true, amount: true, fund: true },
    });
    expect(deposit).toMatchObject({
      category: 'ORDER_PAYMENT',
      fund: 'DRAWER',
    });
    expect(Number(deposit.amount)).toBe(1_000_000);
    expect(
      await prisma.invoice.count({
        where: { orderId: { in: result.data.orderIds }, status: 'PENDING' },
      }),
    ).toBe(2);
  });

  it('makes a custom line its own SKU and turns a percentage discount into an amount', async () => {
    // Hàng hoá có thuộc tính Màu, bàn đang là Nâu: "Màu: Trắng" là đổi thuộc tính, "Đệm" là thông số thêm.
    const color = await prisma.productAttribute.create({
      data: { tenantId, productId, name: 'Màu' },
    });
    await prisma.productItemDetail.create({
      data: {
        productItemId: tableId,
        attributeId: color.id,
        name: 'Màu',
        value: 'Nâu',
      },
    });
    const result = await importer.import(
      owner,
      tenantId,
      await fileOf([
        {
          group: 'LR',
          branch: `CN Hà Nội ${suffix}`,
          fulfillmentType: 'Khách đến lấy',
          assignee,
          orderDiscount: '10%',
          sku: table(),
          quantity: 1,
          customSpecs: 'Màu: Trắng; Đệm: Mút cao su',
          customNote: 'Bo góc tròn',
        },
        { group: 'LR', sku: chair(), quantity: 2, lineDiscount: 100000 },
      ]),
    );
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.data.orderIds[0] },
      include: {
        items: {
          include: {
            customization: {
              include: { specs: { orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
    // Tiền hàng 2.000.000 + 2 × 500.000 - 100.000 = 2.900.000; 10% = 290.000.
    expect(order.discountType).toBe('ORDER');
    expect(Number(order.discountValue)).toBe(290_000);
    expect(Number(order.grandTotal)).toBe(2_610_000);

    const custom = order.items.find((i) => i.isCustom)!;
    expect(custom).toBeDefined();
    expect(custom.productItemId).not.toBe(tableId);
    expect(custom.customization?.note).toBe('Bo góc tròn');
    expect(
      custom.customization?.specs.map((sp) => [
        sp.name,
        sp.value,
        sp.attributeId,
        sp.baseValue,
      ]),
    ).toEqual([
      ['Màu', 'Trắng', color.id, 'Nâu'],
      ['Đệm', 'Mút cao su', null, null],
    ]);
    const details = await prisma.productItemDetail.findMany({
      where: { productItemId: custom.productItemId },
      select: { name: true, value: true },
    });
    expect(details).toEqual(
      expect.arrayContaining([
        { name: 'Màu', value: 'Trắng' },
        { name: 'Đệm', value: 'Mút cao su' },
      ]),
    );
    expect(details).not.toContainEqual({ name: 'Màu', value: 'Nâu' });
    // SKU gốc giữ nguyên.
    expect(
      await prisma.productItemDetail.count({
        where: { productItemId: tableId, value: 'Nâu' },
      }),
    ).toBe(1);
  });

  it('matches an existing customer by phone the second time', async () => {
    const result = await importer.import(
      owner,
      tenantId,
      await fileOf([
        {
          group: 'A',
          branch: `CN Hà Nội ${suffix}`,
          fulfillmentType: 'Khách đến lấy',
          assignee,
          customerPhone,
          sku: table(),
          quantity: 1,
        },
      ]),
    );
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: result.data.orderIds[0] },
      select: { customer: { select: { name: true } } },
    });
    expect(order.customer?.name).toBe('Khách nhập file');
    expect(
      await prisma.customer.count({
        where: { tenantId, phone: customerPhone },
      }),
    ).toBe(1);
  });

  it('creates nothing when one order breaks a rule of POST /orders', async () => {
    const before = await orderCount();
    const customersBefore = await prisma.customer.count({
      where: { tenantId },
    });
    await expect(
      importer.import(
        owner,
        tenantId,
        await fileOf([
          {
            group: 'OK',
            branch: `CN Hà Nội ${suffix}`,
            fulfillmentType: 'Khách đến lấy',
            assignee,
            customerPhone: '0811111111',
            customerName: 'Không được tạo',
            sku: table(),
            quantity: 1,
          },
          {
            // Người phụ trách làm ở chi nhánh khác: lỗi của bước kiểm đơn, không phải của file.
            group: 'BAD',
            branch: `CN 2 ${suffix}`,
            fulfillmentType: 'Khách đến lấy',
            assignee,
            sku: table(),
            quantity: 1,
            deposit: 99_000_000,
            depositMethod: 'Tiền mặt',
          },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.ORDER_IMPORT_ROWS_INVALID,
        errors: [
          {
            row: 3,
            message:
              'Đơn "BAD": Người phụ trách phải làm việc tại chi nhánh của đơn',
          },
        ],
      },
    });
    expect(await orderCount()).toBe(before);
    expect(await prisma.customer.count({ where: { tenantId } })).toBe(
      customersBefore,
    );
  });

  it('keeps a staff account to its own branch', async () => {
    await expect(
      importer.import(
        staffElsewhere,
        tenantId,
        await fileOf([
          {
            group: 'X',
            branch: `CN Hà Nội ${suffix}`,
            fulfillmentType: 'Khách đến lấy',
            assignee,
            sku: table(),
            quantity: 1,
          },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.ORDER_IMPORT_ROWS_INVALID,
        errors: [
          {
            message:
              'Đơn "X": Bạn chỉ nhập được đơn của chi nhánh mình làm việc',
          },
        ],
      },
    });
  });

  it('refuses a file that is not the template', async () => {
    await expect(
      importer.import(
        owner,
        tenantId,
        await fileOf([{ group: 'A' }], ['Tên hàng hóa (*)', 'SKU']),
      ),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.ORDER_IMPORT_FILE_INVALID },
    });
  });
});
