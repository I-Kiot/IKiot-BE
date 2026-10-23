import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { ProductService } from './../src/modules/products/products.service';
import { ProductImportService } from './../src/modules/products/import/product-import.service';
import {
  IMPORT_COLUMNS,
  IMPORT_SHEET,
  LISTS_SHEET,
  headerLabel,
} from './../src/modules/products/import/product-import.columns';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { ErrorCode } from './../src/common/errors/error-codes';

/**
 * Nhập hàng hoá từ Excel (2026-10-20) trên Postgres thật: tải template của cửa hàng, điền vào đúng
 * file đó, nhập - rồi đọc bảng ra kiểm. Một file có lỗi thì không tạo gì. Tự tạo tenant, tự dọn.
 */
describe('ProductImportService', () => {
  let prisma: PrismaService;
  let importer: ProductImportService;

  const tenantId = randomUUID();
  const parentCategoryId = randomUUID();
  const categoryId = randomUUID();
  const brandId = randomUUID();
  const supplierId = randomUUID();
  const tag = tenantId.slice(0, 6);

  const asUpload = (buffer: Buffer, name = 'hang-hoa.xlsx') =>
    ({
      buffer,
      size: buffer.length,
      originalname: name,
    }) as Express.Multer.File;

  /** Template thật của cửa hàng, điền thêm các dòng (theo key cột). */
  const filledTemplate = async (rows: Record<string, unknown>[]) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importer.buildTemplate(tenantId)) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet(IMPORT_SHEET)!;
    rows.forEach((values, i) => {
      IMPORT_COLUMNS.forEach((column, c) => {
        const value = values[column.key];
        if (value !== undefined)
          sheet.getCell(i + 2, c + 1).value = value as ExcelJS.CellValue;
      });
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (
        error as {
          getResponse(): {
            code: string;
            errors: { row: number; column: string; message: string }[];
          };
        }
      ).getResponse();
    }
    throw new Error('expected the import to fail');
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        ProductService,
        ProductImportService,
        {
          provide: SubscriptionService,
          useValue: { assertQuota: async () => {} },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    importer = moduleRef.get(ProductImportService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'product-import-e2e' },
    });
    await prisma.category.create({
      data: { id: parentCategoryId, tenantId, name: 'Nội thất' },
    });
    await prisma.category.create({
      data: {
        id: categoryId,
        tenantId,
        name: 'Bàn',
        parentId: parentCategoryId,
      },
    });
    await prisma.brand.create({
      data: { id: brandId, tenantId, name: 'Hòa Phát' },
    });
    await prisma.supplier.create({
      data: { id: supplierId, tenantId, supplierName: 'Xưởng Gỗ A' },
    });
  });

  afterAll(async () => {
    const where = { tenantId };
    await prisma.productItemSupplier.deleteMany({
      where: { productItem: where },
    });
    await prisma.productItemImage.deleteMany({ where: { productItem: where } });
    await prisma.productItemDetail.deleteMany({
      where: { productItem: where },
    });
    await prisma.productItem.deleteMany({ where });
    await prisma.productAttribute.deleteMany({ where });
    await prisma.productImage.deleteMany({ where: { product: where } });
    await prisma.product.deleteMany({ where });
    await prisma.supplier.deleteMany({ where });
    await prisma.brand.deleteMany({ where });
    await prisma.category.deleteMany({
      where: { tenantId, parentId: { not: null } },
    });
    await prisma.category.deleteMany({ where });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('builds a template with every column, required markers and the shop’s own lists', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importer.buildTemplate(tenantId)) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet(IMPORT_SHEET)!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(IMPORT_COLUMNS.map(headerLabel));
    expect(headers).toContain('Tên hàng hóa (*)');
    expect(headers).toContain('Giá bán (*)');

    const lists = workbook.getWorksheet(LISTS_SHEET)!;
    expect(lists.getCell('A2').value).toBe('Nội thất');
    expect(lists.getCell('A3').value).toBe('Nội thất > Bàn');
    expect(lists.getCell('B2').value).toBe('Hòa Phát');
    expect(lists.getCell('C2').value).toBe('Xưởng Gỗ A');

    const categoryCol =
      IMPORT_COLUMNS.findIndex((c) => c.key === 'category') + 1;
    expect(sheet.getCell(2, categoryCol).dataValidation).toMatchObject({
      type: 'list',
    });
  });

  it('creates products with their variants, attributes, suppliers', async () => {
    const file = await filledTemplate([
      {
        name: `Bàn sồi ${tag}`,
        category: 'Nội thất > Bàn',
        brand: 'Hòa Phát',
        isManufacturable: 'Có',
        sku: `BS-NAU-${tag}`,
        barcode: '0089360001',
        retailPrice: 3500000,
        costPrice: 2400000,
        vat: 10,
        suppliers: 'Xưởng Gỗ A',
        attrName1: 'Màu',
        attrValue1: 'Nâu',
        attrName2: 'Dài',
        attrUnit2: 'cm',
        attrValue2: 120,
      },
      {
        name: `Bàn sồi ${tag}`,
        sku: `BS-TRANG-${tag}`,
        retailPrice: '3.600.000',
        costPrice: 2450000,
        attrName1: 'Màu',
        attrValue1: 'Trắng',
        attrName2: 'Dài',
        attrUnit2: 'cm',
        attrValue2: 120,
      },
      {
        name: `Lắp đặt ${tag}`,
        retailPrice: 200000,
        costPrice: 0,
        itemType: 'Dịch vụ',
      },
    ]);

    const result = await importer.import(tenantId, asUpload(file));
    expect(result.data).toMatchObject({ productCount: 2, itemCount: 3 });

    const table = await prisma.product.findFirstOrThrow({
      where: { tenantId, name: `Bàn sồi ${tag}` },
      include: {
        images: true,
        attributes: { orderBy: { position: 'asc' } },
        productItems: {
          orderBy: { sku: 'asc' },
          include: { details: true, suppliers: true },
        },
      },
    });
    expect(table).toMatchObject({
      categoryId,
      categoryName: 'Bàn',
      brandId,
      isManufacturable: true,
    });
    expect(table.images).toEqual([]);
    expect(table.attributes.map((a) => [a.name, a.unit])).toEqual([
      ['Màu', null],
      ['Dài', 'cm'],
    ]);
    expect(table.productItems).toHaveLength(2);
    const [brown, white] = table.productItems;
    expect(brown.sku).toBe(`BS-NAU-${tag}`);
    expect(brown.barcode).toBe('0089360001');
    expect(Number(brown.vat)).toBe(10);
    expect(brown.productName).toBe(`Bàn sồi ${tag} - Nâu - 120`);
    expect(brown.suppliers.map((s) => s.supplierId)).toEqual([supplierId]);
    expect(brown.details.map((d) => d.value).sort()).toEqual(['120', 'Nâu']);
    expect(Number(white.retailPrice)).toBe(3600000);

    const service = await prisma.productItem.findFirstOrThrow({
      where: { tenantId, productName: `Lắp đặt ${tag}` },
    });
    expect(service.itemType).toBe('SERVICE');
    expect(service.productCode).toMatch(/^SP\d{6}$/);
  });

  it('creates nothing when any row is invalid, and lists every error by row', async () => {
    const before = await prisma.product.count({ where: { tenantId } });
    const file = await filledTemplate([
      { name: `Ghế ${tag}`, retailPrice: 100, costPrice: 50 },
      { name: `Tủ ${tag}`, retailPrice: 'abc', costPrice: 50 },
      // Re-importing an existing product, and an SKU that is already taken.
      { name: `Bàn sồi ${tag}`, retailPrice: 1, costPrice: 1 },
      { name: `Kệ ${tag}`, sku: `BS-NAU-${tag}`, retailPrice: 1, costPrice: 1 },
    ]);

    const response = await errorOf(importer.import(tenantId, asUpload(file)));
    expect(response.code).toBe(ErrorCode.PRODUCT_IMPORT_ROWS_INVALID);
    expect(response.errors.map((e) => [e.row, e.column])).toEqual([
      [3, 'Giá bán'],
      [4, 'Tên hàng hóa'],
      [5, 'SKU'],
    ]);
    expect(await prisma.product.count({ where: { tenantId } })).toBe(before);
  });

  it('rejects a file that is not the template', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRow(['Tên', 'Giá']);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const response = await errorOf(importer.import(tenantId, asUpload(file)));
    expect(response.code).toBe(ErrorCode.PRODUCT_IMPORT_FILE_INVALID);

    const notExcel = await errorOf(
      importer.import(tenantId, asUpload(Buffer.from('a,b'), 'x.csv')),
    );
    expect(notExcel.code).toBe(ErrorCode.PRODUCT_IMPORT_FILE_INVALID);
  });
});
