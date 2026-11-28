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
  headerLabel,
  stockHeader,
} from './../src/modules/products/import/product-import.columns';
import { SubscriptionService } from './../src/modules/subscriptions/subscriptions.service';
import { StockMovementService } from './../src/modules/stock-movement-requests/stock-movement-requests.service';
import { InventoryService } from './../src/modules/inventories/inventories.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { SupplierService } from './../src/modules/suppliers/suppliers.service';
import { ErrorCode } from './../src/common/errors/error-codes';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';
import type { AuthUser } from './../src/common/types/auth-user.type';

/** Tồn đầu kỳ từ file nhập hàng hoá: phiếu ADJUST hoàn tất, lô OPENING, sổ cái (Postgres thật). */
describe('ProductImportService - opening stock', () => {
  let prisma: PrismaService;
  let importer: ProductImportService;

  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const staffId = randomUUID();
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const tag = tenantId.slice(0, 6);
  const branchName = `CN ${tag}`;
  const warehouseName = `Kho ${tag}`;

  const owner = {
    userId: ownerId,
    tenantId,
    systemRole: SystemRole.TENANT_OWNER,
    roleId: null,
    permissions: new Set<string>(),
    branchId: null,
    warehouseId: null,
    shiftSupervision: null,
  } as unknown as AuthUser;

  /** Nhân viên ở chi nhánh, có quyền duyệt điều chỉnh tồn. */
  const staff = {
    userId: staffId,
    tenantId,
    systemRole: SystemRole.STAFF,
    roleId: null,
    permissions: new Set(['products:create', 'stock_movement:approve']),
    branchId,
    warehouseId: null,
    shiftSupervision: null,
  } as unknown as AuthUser;

  const asUpload = (buffer: Buffer) =>
    ({
      buffer,
      size: buffer.length,
      originalname: 'hang-hoa.xlsx',
    }) as Express.Multer.File;

  /** Template thật của cửa hàng; `stock` theo tiêu đề cột tồn kho. */
  const filledTemplate = async (
    rows: { cells: Record<string, unknown>; stock?: Record<string, number> }[],
  ) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importer.buildTemplate(tenantId)) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet(IMPORT_SHEET)!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1);
    rows.forEach(({ cells, stock = {} }, i) => {
      IMPORT_COLUMNS.forEach((column, c) => {
        const value = cells[column.key];
        if (value !== undefined)
          sheet.getCell(i + 2, c + 1).value = value as ExcelJS.CellValue;
      });
      for (const [header, quantity] of Object.entries(stock)) {
        sheet.getCell(i + 2, headers.indexOf(header) + 1).value = quantity;
      }
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (
        error as { getResponse(): { code: string; errors?: unknown[] } }
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
        StockMovementService,
        InventoryService,
        {
          provide: SubscriptionService,
          useValue: { assertQuota: async () => {} },
        },
        { provide: NotificationService, useValue: {} },
        { provide: SupplierService, useValue: {} },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    importer = moduleRef.get(ProductImportService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'product-import-stock-e2e' },
    });
    await prisma.location.createMany({
      data: [
        { id: branchId, tenantId, name: branchName, type: 'BRANCH' },
        { id: warehouseId, tenantId, name: warehouseName, type: 'WAREHOUSE' },
      ],
    });
    await prisma.branch.create({
      data: { id: branchId, tenantId, locationId: branchId },
    });
    await prisma.warehouse.create({
      data: { id: warehouseId, tenantId, locationId: warehouseId },
    });
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          tenantId,
          phoneNumber: `pis-${ownerId}`,
          systemRole: SystemRole.TENANT_OWNER,
          status: UserStatus.ACTIVE,
        },
        {
          id: staffId,
          tenantId,
          phoneNumber: `pis-${staffId}`,
          systemRole: SystemRole.STAFF,
          status: UserStatus.ACTIVE,
          locationId: branchId,
        },
      ],
    });
  });

  afterAll(async () => {
    const where = { tenantId };
    await prisma.inventoryTransaction.deleteMany({ where });
    await prisma.inventoryLot.deleteMany({
      where: { tenantId, parentLotId: { not: null } },
    });
    await prisma.inventoryLot.deleteMany({ where });
    await prisma.inventory.deleteMany({ where });
    await prisma.stockMovementRequest.deleteMany({ where });
    await prisma.productItemDetail.deleteMany({
      where: { productItem: where },
    });
    await prisma.productItem.deleteMany({ where });
    await prisma.productAttribute.deleteMany({ where });
    await prisma.product.deleteMany({ where });
    await prisma.user.deleteMany({ where });
    await prisma.branch.deleteMany({ where });
    await prisma.warehouse.deleteMany({ where });
    await prisma.location.deleteMany({ where });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('adds one stock column per location after the fixed columns, branches first', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importer.buildTemplate(tenantId)) as unknown as ExcelJS.Buffer,
    );
    const headers = (
      workbook.getWorksheet(IMPORT_SHEET)!.getRow(1).values as unknown[]
    ).slice(1);
    expect(headers).toEqual([
      ...IMPORT_COLUMNS.map(headerLabel),
      stockHeader(branchName),
      stockHeader(warehouseName),
    ]);
  });

  it('records the stock as one completed adjustment per location, with lots and ledger rows', async () => {
    const file = await filledTemplate([
      {
        cells: {
          name: `Bàn ${tag}`,
          sku: `BAN-${tag}-1`,
          retailPrice: 1000,
          costPrice: 600,
          attrName1: 'Màu',
          attrValue1: 'Nâu',
        },
        stock: {
          [stockHeader(branchName)]: 5,
          [stockHeader(warehouseName)]: 20,
        },
      },
      {
        cells: {
          name: `Bàn ${tag}`,
          sku: `BAN-${tag}-2`,
          retailPrice: 1000,
          costPrice: 600,
          attrName1: 'Màu',
          attrValue1: 'Trắng',
        },
        stock: { [stockHeader(warehouseName)]: 7 },
      },
    ]);

    const result = await importer.import(tenantId, asUpload(file), owner);
    expect(result.data.stockMovementIds).toHaveLength(2);

    const movements = await prisma.stockMovementRequest.findMany({
      where: { id: { in: result.data.stockMovementIds } },
      include: { details: true },
    });
    for (const movement of movements) {
      expect(movement).toMatchObject({
        movementType: 'ADJUST',
        status: 'COMPLETED',
        createdById: ownerId,
        approvedById: ownerId,
        toLocationId: null,
      });
    }
    const atWarehouse = movements.find(
      (m) => m.fromLocationId === warehouseId,
    )!;
    expect(atWarehouse.details).toHaveLength(2);
    expect(
      atWarehouse.details.map((d) => Number(d.receivedQuantity)).sort(),
    ).toEqual([20, 7]);
    expect(atWarehouse.details.every((d) => Number(d.quantity) === 0)).toBe(
      true,
    );

    const item = await prisma.productItem.findFirstOrThrow({
      where: { tenantId, sku: `BAN-${tag}-1` },
      select: { id: true },
    });
    const stock = await prisma.inventory.findMany({
      where: { tenantId, productItemId: item.id },
      select: { locationId: true, stock: true },
    });
    expect(
      Object.fromEntries(stock.map((row) => [row.locationId, row.stock])),
    ).toEqual({ [branchId]: 5, [warehouseId]: 20 });

    const lots = await prisma.inventoryLot.findMany({
      where: { tenantId, productItemId: item.id },
    });
    expect(lots).toHaveLength(2);
    expect(lots.every((lot) => lot.sourceType === 'OPENING')).toBe(true);
    expect(lots.every((lot) => Number(lot.unitCost) === 600)).toBe(true);

    const ledger = await prisma.inventoryTransaction.findMany({
      where: { tenantId, productItemId: item.id },
    });
    expect(ledger).toHaveLength(2);
    expect(
      ledger.every(
        (row) =>
          row.type === 'ADJUST' &&
          row.referenceType === 'STOCK_MOVEMENT' &&
          result.data.stockMovementIds.includes(row.referenceId),
      ),
    ).toBe(true);
  });

  it('creates no adjustment when every stock cell is blank', async () => {
    const file = await filledTemplate([
      { cells: { name: `Ghế ${tag}`, retailPrice: 10, costPrice: 5 } },
    ]);
    const result = await importer.import(tenantId, asUpload(file), owner);
    expect(result.data.stockMovementIds).toEqual([]);
  });

  it('refuses stock at a location outside the staff member’s posting, creating nothing', async () => {
    const name = `Tủ ${tag}`;
    const file = await filledTemplate([
      {
        cells: { name, retailPrice: 10, costPrice: 5 },
        stock: { [stockHeader(warehouseName)]: 3 },
      },
    ]);
    const response = await errorOf(
      importer.import(tenantId, asUpload(file), staff),
    );
    expect(response.code).toBe(ErrorCode.PRODUCT_IMPORT_STOCK_DENIED);
    expect(await prisma.product.count({ where: { tenantId, name } })).toBe(0);
  });

  it('refuses stock without the adjustment approval permission', async () => {
    const file = await filledTemplate([
      {
        cells: { name: `Kệ ${tag}`, retailPrice: 10, costPrice: 5 },
        stock: { [stockHeader(branchName)]: 3 },
      },
    ]);
    const response = await errorOf(
      importer.import(tenantId, asUpload(file), {
        ...staff,
        permissions: new Set(['products:create']),
      }),
    );
    expect(response.code).toBe(ErrorCode.PRODUCT_IMPORT_STOCK_DENIED);
  });

  it('reports a stock column naming a location the shop does not have', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await filledTemplate([
        { cells: { name: `Đèn ${tag}`, retailPrice: 10, costPrice: 5 } },
      ])) as unknown as ExcelJS.Buffer,
    );
    const sheet = workbook.getWorksheet(IMPORT_SHEET)!;
    sheet.getCell(1, IMPORT_COLUMNS.length + 3).value =
      stockHeader('Kho không tồn tại');
    const response = await errorOf(
      importer.import(
        tenantId,
        asUpload(Buffer.from(await workbook.xlsx.writeBuffer())),
        owner,
      ),
    );
    expect(response.code).toBe(ErrorCode.PRODUCT_IMPORT_FILE_INVALID);
  });
});
