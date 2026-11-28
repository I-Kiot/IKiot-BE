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
import { ProductService } from './../src/modules/products/products.service';
import { OrderImportService } from './../src/modules/orders/import/order-import.service';
import { OrderExportService } from './../src/modules/orders/export/order-export.service';
import { ExportOrdersDto } from './../src/modules/orders/dto/export-orders.dto';
import { ProductImportService } from './../src/modules/products/import/product-import.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { ProductExportService } from './../src/modules/products/export/product-export.service';
import {
  ORDER_IMPORT_COLUMNS,
  ORDER_IMPORT_SHEET,
  orderHeaderLabel,
} from './../src/modules/orders/import/order-import.columns';
import type { OrderImportColumnKey } from './../src/modules/orders/import/order-import.columns';
import {
  IMPORT_COLUMNS,
  IMPORT_SHEET,
  headerLabel,
  stockHeader,
} from './../src/modules/products/import/product-import.columns';
import type { ImportColumnKey } from './../src/modules/products/import/product-import.columns';
import { cellValue } from './../src/common/excel/import-cells';
import { baseSkuOfCustom } from './../src/modules/orders/custom-sku';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import type { AuthUser } from './../src/common/types/auth-user.type';

/** Xuất Excel theo khuôn file mẫu nhập (Postgres thật): đúng tiêu đề, đúng giá trị, nhập lại được. */
describe('Excel export in the import template format', () => {
  let prisma: PrismaService;
  let orderImporter: OrderImportService;
  let orderExporter: OrderExportService;
  let productExporter: ProductExportService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const branchId = randomUUID();
  const productId = randomUUID();
  const serviceId = randomUUID();
  const tableId = randomUUID(); // 2.000.000
  const chairId = randomUUID(); // 500.000
  const installId = randomUUID();
  const parentCategoryId = randomUUID();
  const categoryId = randomUUID();
  const brandId = randomUUID();
  const supplierIds = [randomUUID(), randomUUID()];
  const suffix = tenantId.slice(0, 6);
  const staffPhone = `09${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const customerPhone = `08${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const branchName = `CN Xuất ${suffix}`;
  const assignee = `Nhân viên ${suffix} - ${staffPhone}`;
  const table = `XE-${tableId.slice(0, 8)}`;
  const chair = `XE-${chairId.slice(0, 8)}`;

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
  } as unknown as AuthUser;

  async function orderFile(
    rows: Partial<Record<OrderImportColumnKey, string | number>>[],
  ): Promise<Express.Multer.File> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(ORDER_IMPORT_SHEET);
    sheet.addRow(ORDER_IMPORT_COLUMNS.map(orderHeaderLabel));
    for (const row of rows) {
      sheet.addRow(ORDER_IMPORT_COLUMNS.map((c) => row[c.key] ?? null));
    }
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return asFile(buffer);
  }

  function asFile(buffer: Buffer): Express.Multer.File {
    return {
      buffer,
      size: buffer.length,
      originalname: 'xuat.xlsx',
    } as Express.Multer.File;
  }

  /** Đọc trang dữ liệu: tiêu đề dòng 1, mỗi dòng sau thành object theo khoá cột. */
  async function readSheet<K extends string>(
    buffer: Buffer,
    sheetName: string,
    columns: readonly { key: K }[],
  ) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet(sheetName)!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    const rows: Partial<Record<K, unknown>>[] = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const values: Partial<Record<K, unknown>> = {};
      columns.forEach((column, i) => {
        const value = cellValue(row.getCell(i + 1));
        if (value !== null && value !== undefined) values[column.key] = value;
      });
      if (Object.keys(values).length > 0) rows.push(values);
    });
    return { workbook, headers, rows };
  }

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
        OrderExportService,
        ProductImportService,
        ProductExportService,
        { provide: ProductService, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: RealtimeGateway, useValue: {} },
        { provide: SepayOrderService, useValue: {} },
        { provide: PromotionService, useValue: {} },
        { provide: StockMovementService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    orderImporter = moduleRef.get(OrderImportService);
    orderExporter = moduleRef.get(OrderExportService);
    productExporter = moduleRef.get(ProductExportService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'excel-export-e2e' },
    });
    await prisma.location.create({
      data: { id: branchId, tenantId, name: branchName, type: 'BRANCH' },
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: `xe-${ownerId}`,
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
      ],
    });
    await prisma.category.create({
      data: { id: parentCategoryId, tenantId, name: 'Nội thất' },
    });
    await prisma.category.create({
      data: {
        id: categoryId,
        tenantId,
        name: 'Bàn ghế',
        parentId: parentCategoryId,
      },
    });
    await prisma.brand.create({
      data: { id: brandId, tenantId, name: `Hãng ${suffix}` },
    });
    await prisma.supplier.createMany({
      data: supplierIds.map((id, i) => ({
        id,
        tenantId,
        supplierName: `NCC ${i + 1} ${suffix}`,
      })),
    });
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: `Bộ bàn ghế ${suffix}`,
        categoryId,
        brandId,
        isManufacturable: true,
      },
    });
    await prisma.product.create({
      data: {
        id: serviceId,
        tenantId,
        name: `Lắp đặt ${suffix}`,
        productType: 'SERVICE',
        status: 'INACTIVE',
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
          productCode: `XE-${id}`,
          sku: `XE-${id.slice(0, 8)}`,
          retailPrice: price,
          costPrice: price / 2,
          vat: 10,
          warrantyPeriod: '12 tháng',
          itemType: 'PRODUCT',
        },
      });
    }
    await prisma.productItem.create({
      data: {
        id: installId,
        tenantId,
        productId: serviceId,
        productName: `Lắp đặt ${suffix}`,
        productCode: `XE-${installId}`,
        retailPrice: 200_000,
        costPrice: 0,
        itemType: 'SERVICE',
      },
    });
    // Màu (chữ) và Dài (đơn vị cm) trên bàn; ghế chỉ có Màu.
    const color = await prisma.productAttribute.create({
      data: { tenantId, productId, name: 'Màu', position: 0 },
    });
    const length = await prisma.productAttribute.create({
      data: { tenantId, productId, name: 'Dài', unit: 'cm', position: 1 },
    });
    await prisma.productItemDetail.createMany({
      data: [
        {
          productItemId: tableId,
          attributeId: color.id,
          name: 'Màu',
          value: 'Nâu',
          position: 0,
        },
        {
          productItemId: tableId,
          attributeId: length.id,
          name: 'Dài',
          value: '120',
          position: 1,
        },
        {
          productItemId: chairId,
          attributeId: color.id,
          name: 'Màu',
          value: 'Đen',
          position: 0,
        },
      ],
    });
    await prisma.productItemSupplier.createMany({
      data: supplierIds.map((supplierId) => ({
        productItemId: tableId,
        supplierId,
      })),
    });
  });

  afterAll(async () => {
    await prisma.cashFlow.deleteMany({ where: { tenantId } });
    await prisma.payment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.orderEvent.deleteMany({ where: { tenantId } });
    await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.comboComponent.deleteMany({
      where: { comboItem: { tenantId } },
    });
    await prisma.productItem.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.supplier.deleteMany({ where: { tenantId } });
    await prisma.brand.deleteMany({ where: { tenantId } });
    await prisma.category.deleteMany({
      where: { tenantId, parentId: { not: null } },
    });
    await prisma.category.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.branch.deleteMany({ where: { tenantId } });
    await prisma.location.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  let importedIds: string[] = [];

  it('exports orders in the import template, and the exported file imports again', async () => {
    const imported = await orderImporter.import(
      owner,
      tenantId,
      await orderFile([
        {
          group: 'DH1',
          branch: branchName,
          fulfillmentType: 'Giao tận nơi',
          assignee,
          priority: 'Gấp',
          customerPhone,
          customerName: 'Khách xuất file',
          deliveryAddress: '12 Láng Hạ',
          requestedDeliveryDate: '30/12/2026',
          shippingFee: 50000,
          orderDiscount: 100000,
          deposit: 1_000_000,
          depositMethod: 'Chuyển khoản',
          note: 'Gọi trước',
          sku: table,
          quantity: 1,
        },
        {
          group: 'DH1',
          sku: chair,
          quantity: 2,
          unitPrice: 400000,
          lineDiscount: 50000,
        },
        {
          group: 'DH2',
          branch: branchName,
          fulfillmentType: 'Khách đến lấy',
          assignee,
          sku: table,
          quantity: 1,
          customSpecs: 'Màu: Trắng; Đệm: Mút',
          customNote: 'Bo góc',
        },
      ]),
    );
    importedIds = imported.data.orderIds;
    const [code1, code2] = imported.data.codes;

    const buffer = await orderExporter.export(
      owner,
      tenantId,
      Object.assign(new ExportOrdersDto(), { sort: 'createdAt' as const }),
    );
    const { workbook, headers, rows } = await readSheet(
      buffer,
      ORDER_IMPORT_SHEET,
      ORDER_IMPORT_COLUMNS,
    );
    // Cùng khuôn file mẫu: đủ trang, đúng tiêu đề, không có đơn mẫu.
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'Đơn hàng',
      'Hướng dẫn',
      'Danh sách',
    ]);
    expect(headers).toEqual(ORDER_IMPORT_COLUMNS.map(orderHeaderLabel));
    expect(rows.some((r) => String(r.group).startsWith('MẪU-'))).toBe(false);

    // Mới nhất trước: DH2 (một dòng làm riêng) rồi DH1 (hai dòng, thông tin đơn chỉ ở dòng đầu).
    expect(rows).toHaveLength(3);
    // Dòng làm riêng ghi SKU gốc (bàn), không phải SKU riêng của dòng.
    expect(rows[0]).toEqual({
      group: code2,
      branch: branchName,
      fulfillmentType: 'Khách đến lấy',
      assignee,
      seller: expect.stringContaining('- xe-'),
      priority: 'Bình thường',
      sku: table,
      quantity: 1,
      unitPrice: 2_000_000,
      customSpecs: 'Màu: Trắng; Đệm: Mút',
      customNote: 'Bo góc',
    });
    expect(rows[1]).toEqual({
      group: code1,
      branch: branchName,
      fulfillmentType: 'Giao tận nơi',
      assignee,
      seller: expect.stringContaining('- xe-'),
      priority: 'Gấp',
      customerPhone,
      customerName: 'Khách xuất file',
      recipientName: 'Khách xuất file',
      recipientPhone: customerPhone,
      deliveryAddress: '12 Láng Hạ',
      requestedDeliveryDate: '30/12/2026',
      shippingFee: 50000,
      orderDiscount: 100000,
      deposit: 1_000_000,
      depositMethod: 'Chuyển khoản',
      note: 'Gọi trước',
      sku: table,
      quantity: 1,
      unitPrice: 2_000_000,
    });
    expect(rows[2]).toEqual({
      group: code1,
      sku: chair,
      quantity: 2,
      unitPrice: 400000,
      lineDiscount: 50000,
    });

    // Nhập lại nguyên file vừa xuất: ra đơn cùng tiền.
    const again = await orderImporter.import(owner, tenantId, asFile(buffer));
    expect(again.data.orderCount).toBe(2);
    const totals = async (ids: string[]) =>
      (
        await prisma.order.findMany({
          where: { id: { in: ids } },
          select: { grandTotal: true },
        })
      )
        .map((o) => Number(o.grandTotal))
        .sort();
    expect(await totals(again.data.orderIds)).toEqual(
      await totals(importedIds),
    );
    // Dòng làm riêng nhập lại được làm từ bàn gốc, không phải từ SKU riêng của lần trước.
    const remade = await prisma.orderItem.findMany({
      where: { orderId: { in: again.data.orderIds }, isCustom: true },
      select: { sku: true },
    });
    expect(remade).toHaveLength(1);
    expect(baseSkuOfCustom(remade[0].sku ?? '')).toBe(table);
  });

  it('copies the same cells as the export, in the template column order', async () => {
    const query = Object.assign(new ExportOrdersDto(), {
      ids: [importedIds[0]],
    });
    const cells = await orderExporter.cells(owner, tenantId, query);
    const { rows } = await readSheet(
      await orderExporter.export(owner, tenantId, query),
      ORDER_IMPORT_SHEET,
      ORDER_IMPORT_COLUMNS,
    );
    expect(cells).toHaveLength(2);
    expect(
      cells.every((row) => row.length === ORDER_IMPORT_COLUMNS.length),
    ).toBe(true);
    // Mỗi ô chép ra đúng bằng ô cùng cột trong file xuất.
    expect(
      cells.map((row) =>
        Object.fromEntries(
          ORDER_IMPORT_COLUMNS.flatMap((c, i) =>
            row[i] === null ? [] : [[c.key, row[i]]],
          ),
        ),
      ),
    ).toEqual(rows);
  });

  it('exports only the ticked orders, still inside the list filters', async () => {
    const buffer = await orderExporter.export(
      owner,
      tenantId,
      Object.assign(new ExportOrdersDto(), {
        ids: [importedIds[0]],
        fulfillmentType: 'HOME_DELIVERY',
      }),
    );
    const { rows } = await readSheet(
      buffer,
      ORDER_IMPORT_SHEET,
      ORDER_IMPORT_COLUMNS,
    );
    expect(rows.map((r) => r.sku)).toEqual([table, chair]);

    // Đơn đã tích nhưng không khớp bộ lọc thì không ra.
    const none = await orderExporter.export(
      owner,
      tenantId,
      Object.assign(new ExportOrdersDto(), {
        ids: [importedIds[0]],
        fulfillmentType: 'STORE_PICKUP',
      }),
    );
    expect(
      (await readSheet(none, ORDER_IMPORT_SHEET, ORDER_IMPORT_COLUMNS)).rows,
    ).toEqual([]);
  });

  it('exports products in the import template, one row per SKU, without made-to-order SKUs', async () => {
    // Tồn của bàn ở chi nhánh; ghế không có dòng tồn nào.
    await prisma.inventory.create({
      data: {
        tenantId,
        locationId: branchId,
        productItemId: tableId,
        stock: 7,
      },
    });
    let buffer: Buffer;
    try {
      buffer = await productExporter.export(tenantId, {});
    } finally {
      await prisma.inventory.deleteMany({ where: { tenantId } });
    }
    const { workbook, headers, rows } = await readSheet<ImportColumnKey>(
      buffer,
      IMPORT_SHEET,
      IMPORT_COLUMNS,
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'Hàng hóa',
      'Hướng dẫn',
      'Danh sách',
    ]);
    expect(headers).toEqual([
      ...IMPORT_COLUMNS.map(headerLabel),
      stockHeader(branchName),
    ]);
    // Cột tồn kho: dịch vụ để trống, hàng có tồn ghi số, hàng chưa có dòng tồn ghi 0.
    const stockCells = [2, 3, 4].map(
      (n) =>
        workbook
          .getWorksheet(IMPORT_SHEET)!
          .getCell(n, IMPORT_COLUMNS.length + 1).value,
    );
    expect(stockCells).toEqual([null, 7, 0]);

    // SKU riêng của dòng làm riêng (từ test trên) không ra file.
    expect(rows.map((r) => r.sku ?? r.productCode)).toEqual([
      `XE-${installId}`,
      table,
      chair,
    ]);
    const common = {
      name: `Bộ bàn ghế ${suffix}`,
      productType: 'Hàng hóa',
      category: 'Nội thất > Bàn ghế',
      brand: `Hãng ${suffix}`,
      status: 'Đang kinh doanh',
      isManufacturable: 'Có',
      vat: 10,
      warrantyPeriod: '12 tháng',
    };
    expect(rows[0]).toEqual({
      name: `Lắp đặt ${suffix}`,
      productType: 'Dịch vụ',
      status: 'Ngừng kinh doanh',
      isManufacturable: 'Không',
      itemName: `Lắp đặt ${suffix}`,
      productCode: `XE-${installId}`,
      retailPrice: 200000,
      costPrice: 0,
    });
    expect(rows[1]).toEqual({
      ...common,
      itemName: 'Bàn',
      productCode: `XE-${tableId}`,
      sku: table,
      retailPrice: 2_000_000,
      costPrice: 1_000_000,
      suppliers: expect.stringMatching(/^NCC \d .+; NCC \d .+$/),
      attrName1: 'Màu',
      attrValue1: 'Nâu',
      attrName2: 'Dài',
      attrUnit2: 'cm',
      attrValue2: '120',
    });
    expect(rows[2]).toEqual({
      ...common,
      itemName: 'Ghế',
      productCode: `XE-${chairId}`,
      sku: chair,
      retailPrice: 500000,
      costPrice: 250000,
      attrName1: 'Màu',
      attrValue1: 'Đen',
    });

    // Lọc theo loại và theo hàng đã tích.
    const services = await productExporter.export(tenantId, {
      productType: ['SERVICE'],
    });
    expect(
      (await readSheet(services, IMPORT_SHEET, IMPORT_COLUMNS)).rows,
    ).toHaveLength(1);
    const ticked = await productExporter.export(tenantId, { ids: [productId] });
    expect(
      (await readSheet(ticked, IMPORT_SHEET, IMPORT_COLUMNS)).rows,
    ).toHaveLength(2);
  });

  // Cuối suite: combo tạo ở đây không được lọt vào test xuất hàng hoá phía trên.
  it('exports the customized components of a combo as sub-rows that import again', async () => {
    const comboProductId = randomUUID();
    const comboItemId = randomUUID();
    const combo = `XE-${comboItemId.slice(0, 8)}`;
    await prisma.product.create({
      data: {
        id: comboProductId,
        tenantId,
        name: `Combo ${suffix}`,
        productType: 'COMBO',
      },
    });
    await prisma.productItem.create({
      data: {
        id: comboItemId,
        tenantId,
        productId: comboProductId,
        productName: `Combo ${suffix}`,
        productCode: `XE-${comboItemId}`,
        sku: combo,
        retailPrice: 2_300_000,
        costPrice: 1_250_000,
        itemType: 'COMBO',
      },
    });
    await prisma.comboComponent.createMany({
      data: [
        { comboItemId, componentItemId: tableId, quantity: 1 },
        { comboItemId, componentItemId: chairId, quantity: 2 },
      ],
    });

    const imported = await orderImporter.import(
      owner,
      tenantId,
      await orderFile([
        {
          group: 'K1',
          branch: branchName,
          fulfillmentType: 'Khách đến lấy',
          assignee,
          sku: combo,
          quantity: 1,
        },
        {
          group: 'K1',
          comboParent: combo,
          sku: table,
          customSpecs: 'Dài: 200 cm; Đệm: Mút',
        },
        {
          group: 'K1',
          comboParent: combo,
          sku: chair,
          customNote: 'Sơn mờ',
        },
      ]),
    );
    const [orderId] = imported.data.orderIds;

    // Hai món được làm riêng trên dòng con của combo, dòng combo vẫn là dòng duy nhất mang giá.
    const lines = await prisma.orderItem.findMany({
      where: { orderId },
      select: {
        lineType: true,
        isCustom: true,
        sku: true,
        customization: { select: { note: true } },
      },
    });
    expect(lines.filter((l) => l.lineType === 'COMBO')).toHaveLength(1);
    const parts = lines.filter((l) => l.lineType === 'COMBO_COMPONENT');
    expect(parts).toHaveLength(2);
    expect(parts.every((l) => l.isCustom && l.sku?.includes('-C'))).toBe(true);

    const query = Object.assign(new ExportOrdersDto(), { ids: [orderId] });
    const buffer = await orderExporter.export(owner, tenantId, query);
    const { rows } = await readSheet(
      buffer,
      ORDER_IMPORT_SHEET,
      ORDER_IMPORT_COLUMNS,
    );
    const code = imported.data.codes[0];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ group: code, sku: combo, quantity: 1 });
    // Dòng phụ ghi SKU gốc của món (không phải SKU riêng), để file nhập lại được.
    expect(
      rows.slice(1).sort((a, b) => String(a.sku).localeCompare(String(b.sku))),
    ).toEqual(
      [
        {
          group: code,
          comboParent: combo,
          sku: table,
          customSpecs: 'Dài: 200 cm; Đệm: Mút',
        },
        { group: code, comboParent: combo, sku: chair, customNote: 'Sơn mờ' },
      ].sort((a, b) => a.sku.localeCompare(b.sku)),
    );
    // Nút "Sao chép" cùng nguồn dữ liệu: có đủ ba dòng.
    expect(await orderExporter.cells(owner, tenantId, query)).toHaveLength(3);

    const again = await orderImporter.import(owner, tenantId, asFile(buffer));
    const copies = await prisma.orderItem.count({
      where: {
        orderId: again.data.orderIds[0],
        lineType: 'COMBO_COMPONENT',
        isCustom: true,
      },
    });
    expect(copies).toBe(2);
  });
});
