import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { cellValue } from '../../../common/excel/import-cells';
import type { CellValue } from '../../../common/excel/import-cells';
import { PrismaService } from '../../../prisma/prisma.service';
import { ErrorCode } from '../../../common/errors/error-codes';
import { ProductStatus } from '../../../common/constants/product-status';
import { ProductService } from '../products.service';
import { StockMovementService } from '../../stock-movement-requests/stock-movement-requests.service';
import { LocationStatus } from '../../../common/constants/location-status';
import { LocationType } from '../../../common/constants/location-type';
import { canActAt } from '../../../common/utils/location-access';
import { can } from '../../../common/utils/permission';
import type { AuthUser } from '../../../common/types/auth-user.type';
import { CreateProductDto } from '../dto/create-product.dto';
import {
  GUIDE_SHEET,
  IMPORT_COLUMNS,
  IMPORT_SHEET,
  LISTS_SHEET,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  NO,
  PRODUCT_TYPE_LABELS,
  STATUS_LABELS,
  STOCK_COLUMN_FORMAT,
  STOCK_COLUMN_NOTE,
  STOCK_COLUMN_WIDTH,
  YES,
  headerKey,
  headerLabel,
  stockHeader,
  stockLocationOf,
} from './product-import.columns';
import type {
  ImportColumn,
  ImportColumnKey,
  ImportList,
} from './product-import.columns';
import {
  buildNameIndex,
  normalizeName,
  parseImportRows,
  textOf,
} from './product-import.parser';
import type {
  ImportError,
  ImportLookups,
  ImportRow,
  StockCell,
} from './product-import.parser';

/** Lỗi trả về tối đa - một file hỏng toàn bộ không cần liệt kê 5000 dòng giống nhau. */
const MAX_REPORTED_ERRORS = 200;

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Một dòng của trang "Hàng hóa": giá trị theo khoá cột, cộng tồn kho theo id địa điểm (cột "Tồn kho - ..."). */
export type ProductSheetRow = Partial<Record<ImportColumnKey, CellValue>> & {
  /** Địa điểm không có trong map thì để trống ô. */
  stock?: Record<string, number>;
};

export interface ImportResult {
  message: string;
  data: {
    productCount: number;
    itemCount: number;
    productIds: string[];
    /** Phiếu điều chỉnh tồn đầu kỳ đã tạo, mỗi địa điểm một phiếu. */
    stockMovementIds: string[];
  };
}

/** Kho/chi nhánh có cột tồn kho trên file - mọi địa điểm chưa xoá của cửa hàng. */
interface StockLocation {
  id: string;
  name: string;
  type: string;
}

const OPENING_STOCK_NOTE = 'Tồn đầu kỳ từ file nhập hàng hóa';

/** Nhập hàng hoá từ Excel: cả file đúng mới tạo, đi qua `ProductService.createMany`. */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductService,
    private readonly movements: StockMovementService,
  ) {}

  // ─── File mẫu ───

  /** Template theo cửa hàng: dropdown danh mục, thương hiệu, NCC lấy từ dữ liệu hiện có. */
  buildTemplate(tenantId: string): Promise<Buffer> {
    return this.buildFile(tenantId, []);
  }

  /** File cùng khuôn với file mẫu, trang "Hàng hóa" điền sẵn `rows` (xuất file dùng để sửa rồi nhập lại). */
  async buildFile(tenantId: string, rows: ProductSheetRow[]): Promise<Buffer> {
    const [categories, brands, suppliers, locations] = await Promise.all([
      this.categoryLabels(tenantId),
      this.prisma.brand.findMany({
        where: { tenantId },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.supplier.findMany({
        where: { tenantId },
        select: { supplierName: true },
        orderBy: { supplierName: 'asc' },
      }),
      this.stockLocations(tenantId),
    ]);
    const lists: Record<ImportList, string[]> = {
      categories: categories.map((c) => c.path).sort(),
      brands: unique(brands.map((b) => b.name)),
      suppliers: unique(suppliers.map((s) => s.supplierName)),
      statuses: Object.values(STATUS_LABELS),
      productTypes: Object.values(PRODUCT_TYPE_LABELS),
      yesNo: [YES, NO],
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'iKiot';
    const sheet = workbook.addWorksheet(IMPORT_SHEET, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const guide = workbook.addWorksheet(GUIDE_SHEET);
    const listSheet = workbook.addWorksheet(LISTS_SHEET);

    const listRanges = this.writeLists(listSheet, lists);
    this.writeDataSheet(sheet, listRanges, rows.length);
    this.writeStockColumns(sheet, locations);
    this.writeRows(sheet, rows, locations);
    this.writeGuide(guide, locations);

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private writeLists(
    sheet: ExcelJS.Worksheet,
    lists: Record<ImportList, string[]>,
  ): Partial<Record<ImportList, string>> {
    const titles: Record<ImportList, string> = {
      categories: 'Danh mục',
      brands: 'Thương hiệu',
      suppliers: 'Nhà cung cấp',
      statuses: 'Trạng thái',
      productTypes: 'Loại hàng hóa',
      yesNo: 'Có / Không',
    };
    const ranges: Partial<Record<ImportList, string>> = {};
    (Object.keys(titles) as ImportList[]).forEach((list, index) => {
      const col = index + 1;
      const letter = sheet.getColumn(col).letter;
      sheet.getColumn(col).width = 28;
      const header = sheet.getCell(1, col);
      header.value = titles[list];
      header.font = { bold: true };
      lists[list].forEach((value, i) => {
        sheet.getCell(i + 2, col).value = value;
      });
      if (lists[list].length > 0) {
        ranges[list] =
          `'${LISTS_SHEET}'!$${letter}$2:$${letter}$${lists[list].length + 1}`;
      }
    });
    sheet.getCell(1, 8).value =
      'Trang này là nguồn cho các ô chọn ở trang "Hàng hóa". Muốn thêm danh mục/thương hiệu/NCC, hãy tạo trên hệ thống rồi tải lại file mẫu.';
    sheet.getCell(1, 8).font = { italic: true, color: { argb: 'FF6B7280' } };
    return ranges;
  }

  private writeDataSheet(
    sheet: ExcelJS.Worksheet,
    listRanges: Partial<Record<ImportList, string>>,
    dataRows: number,
  ): void {
    // Dropdown phủ hết dòng dữ liệu đã điền, tối thiểu bằng giới hạn một lần nhập.
    const lastRow = Math.max(MAX_IMPORT_ROWS, dataRows) + 1;
    IMPORT_COLUMNS.forEach((column, index) => {
      const col = index + 1;
      sheet.getColumn(col).width = column.width;
      if (column.text) sheet.getColumn(col).numFmt = '@';
      if (column.money) sheet.getColumn(col).numFmt = '#,##0';

      const cell = sheet.getCell(1, col);
      cell.value = headerLabel(column);
      cell.font = {
        bold: true,
        color: { argb: column.required ? 'FFFFFFFF' : 'FF111827' },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {
          argb: column.required
            ? 'FFDC2626'
            : column.level === 'product'
              ? 'FFDBEAFE'
              : 'FFF3F4F6',
        },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
      cell.note = this.noteFor(column);

      const range = column.list ? listRanges[column.list] : undefined;
      if (!range) return;
      const validation: ExcelJS.DataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [range],
        showErrorMessage: !column.freeText,
        errorStyle: 'stop',
        errorTitle: column.header,
        error: 'Hãy chọn một giá trị trong danh sách.',
      };
      for (let row = 2; row <= lastRow; row++) {
        sheet.getCell(row, col).dataValidation = validation;
      }
    });
    sheet.getRow(1).height = 36;
  }

  /** Các cột "Tồn kho - <địa điểm>", nối sau các cột cố định. */
  private writeStockColumns(
    sheet: ExcelJS.Worksheet,
    locations: StockLocation[],
  ): void {
    locations.forEach((location, index) => {
      const col = IMPORT_COLUMNS.length + index + 1;
      sheet.getColumn(col).width = STOCK_COLUMN_WIDTH;
      sheet.getColumn(col).numFmt = '#,##0';
      const cell = sheet.getCell(1, col);
      cell.value = stockHeader(location.name);
      cell.font = { bold: true, color: { argb: 'FF111827' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFDCFCE7' },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
      cell.note = [
        'Không bắt buộc',
        `Tồn kho của từng mặt hàng (SKU) tại ${locationLabel(location)}.`,
        `Định dạng: ${STOCK_COLUMN_FORMAT}`,
        STOCK_COLUMN_NOTE,
      ].join('\n');
    });
  }

  /** Địa điểm có cột tồn kho: chi nhánh trước, rồi kho, theo tên. */
  private async stockLocations(tenantId: string): Promise<StockLocation[]> {
    const rows = await this.prisma.location.findMany({
      where: { tenantId, status: { not: LocationStatus.DELETED } },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    });
    const rank = (type: string) => (type === LocationType.BRANCH ? 0 : 1);
    return rows.sort((a, b) => rank(a.type) - rank(b.type));
  }

  /** Ghi dữ liệu từ dòng 2, theo đúng thứ tự cột của template. */
  private writeRows(
    sheet: ExcelJS.Worksheet,
    rows: ProductSheetRow[],
    locations: StockLocation[],
  ): void {
    rows.forEach((values, index) => {
      const row = sheet.getRow(index + 2);
      IMPORT_COLUMNS.forEach((column, col) => {
        const value = values[column.key];
        if (value === undefined || value === null || value === '') return;
        row.getCell(col + 1).value = value;
      });
      // Cột tồn kho nối sau cột cố định, cùng thứ tự với `writeStockColumns`.
      locations.forEach((location, i) => {
        const quantity = values.stock?.[location.id];
        if (quantity === undefined) return;
        row.getCell(IMPORT_COLUMNS.length + i + 1).value = quantity;
      });
    });
  }

  private noteFor(column: ImportColumn): string {
    return [
      column.required ? 'BẮT BUỘC' : 'Không bắt buộc',
      column.level === 'product'
        ? 'Thông tin hàng hóa: chỉ cần điền ở dòng đầu tiên của hàng hóa.'
        : 'Thông tin từng mặt hàng (SKU).',
      `Định dạng: ${column.format}`,
      column.note,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private writeGuide(
    sheet: ExcelJS.Worksheet,
    locations: StockLocation[],
  ): void {
    sheet.getColumn(1).width = 22;
    sheet.getColumn(2).width = 11;
    sheet.getColumn(3).width = 16;
    sheet.getColumn(4).width = 34;
    sheet.getColumn(5).width = 26;
    sheet.getColumn(6).width = 70;

    const title = sheet.getCell('A1');
    title.value = 'HƯỚNG DẪN NHẬP HÀNG HÓA TỪ FILE EXCEL';
    title.font = { bold: true, size: 14 };

    const rules = [
      `Điền dữ liệu ở trang "${IMPORT_SHEET}", bắt đầu từ dòng 2. Không đổi tên trang và không sửa dòng tiêu đề.`,
      'Mỗi dòng là một mặt hàng (SKU). Các dòng có cùng "Tên hàng hóa" là các phiên bản của cùng một hàng hóa (ví dụ cùng một bàn nhưng khác màu, khác kích thước).',
      'Cột tiêu đề màu đỏ có (*) là bắt buộc. Cột tiêu đề màu xanh là thông tin của hàng hóa - chỉ cần điền ở dòng đầu tiên; nếu điền ở các dòng sau thì phải giống dòng đầu.',
      'Các phiên bản của cùng một hàng hóa phân biệt nhau bằng "Thuộc tính / Giá trị" (ví dụ Màu: Nâu, Màu: Trắng). Hai dòng trùng cả tên mặt hàng lẫn giá trị thuộc tính sẽ bị báo lỗi.',
      'Danh mục, thương hiệu, nhà cung cấp phải có sẵn trên hệ thống - chọn trong ô thả xuống. Muốn thêm mới, tạo trên hệ thống rồi tải lại file mẫu.',
      'Mã hàng và SKU có thể bỏ trống để hệ thống tự sinh. Mã hàng, SKU và mã vạch không được trùng trong file và với mã đã có trong cửa hàng.',
      'File chỉ tạo hàng hóa mới: tên hàng hóa trùng với hàng đã có trong cửa hàng sẽ bị báo lỗi.',
      'Tồn kho: mỗi kho/chi nhánh có một cột "Tồn kho - <tên địa điểm>" (tiêu đề màu xanh lá) ở cuối trang. Ghi số lượng đang có của từng mặt hàng tại đó; bỏ trống = không có hàng. Mỗi địa điểm có số lượng sẽ có một phiếu điều chỉnh tồn kho đã hoàn tất, xem ở màn Điều chỉnh tồn kho. Không đổi tên tiêu đề các cột này. Cần quyền duyệt điều chỉnh tồn kho tại địa điểm đó.',
      'Combo không nhập được bằng file - hãy tạo combo trên màn hình hàng hóa.',
      'File không có cột ảnh: sau khi nhập, thêm ảnh cho hàng hóa và từng mặt hàng trên màn hình hàng hóa.',
      `Tối đa ${MAX_IMPORT_ROWS} dòng, file .xlsx không quá ${MAX_IMPORT_BYTES / 1024 / 1024}MB.`,
      'Hệ thống kiểm tra toàn bộ file trước khi tạo: chỉ cần một dòng sai là không có hàng hóa nào được tạo, và mọi lỗi được liệt kê theo dòng để sửa một lần.',
    ];
    let row = 3;
    for (const [i, rule] of rules.entries()) {
      sheet.mergeCells(row, 1, row, 6);
      const cell = sheet.getCell(row, 1);
      cell.value = `${i + 1}. ${rule}`;
      cell.alignment = { wrapText: true, vertical: 'top' };
      sheet.getRow(row).height = 30;
      row++;
    }

    row++;
    const tableHeader = sheet.getRow(row);
    tableHeader.values = [
      'Cột',
      'Bắt buộc',
      'Áp dụng cho',
      'Định dạng',
      'Ví dụ',
      'Ghi chú',
    ];
    tableHeader.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    tableHeader.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F2937' },
      };
    });
    row++;
    for (const column of IMPORT_COLUMNS) {
      const r = sheet.getRow(row++);
      r.values = [
        headerLabel(column),
        column.required ? 'Có' : '',
        column.level === 'product' ? 'Hàng hóa' : 'Từng mặt hàng',
        column.format,
        column.example,
        column.note,
      ];
      r.alignment = { wrapText: true, vertical: 'top' };
      if (column.required) {
        r.getCell(1).font = { bold: true, color: { argb: 'FFDC2626' } };
      }
    }
    for (const location of locations) {
      const r = sheet.getRow(row++);
      r.values = [
        stockHeader(location.name),
        '',
        'Từng mặt hàng',
        STOCK_COLUMN_FORMAT,
        '',
        `${locationLabel(location)}. ${STOCK_COLUMN_NOTE}`,
      ];
      r.alignment = { wrapText: true, vertical: 'top' };
    }

    // Mỗi dòng tạo một mặt hàng; "Tên hàng hóa" quyết định nó thuộc hàng hoá nào.
    row++;
    sheet.mergeCells(row, 1, row, 6);
    sheet.getCell(row, 1).value =
      '"TÊN HÀNG HÓA" VÀ "TÊN MẶT HÀNG" - mỗi dòng luôn tạo một mặt hàng (SKU); các dòng cùng "Tên hàng hóa" được gom vào một hàng hóa:';
    sheet.getCell(row, 1).font = { bold: true };
    row++;
    const labelOf = (key: ImportColumn['key']) =>
      IMPORT_COLUMNS.filter((c) => c.key === key).map(headerLabel)[0] ?? key;
    // Cột Thuộc tính gộp B:C, Tên mặt hàng gộp D:E, Kết quả ở F - để khớp độ rộng cột của trang.
    const nameRows = [
      [labelOf('name'), 'Thuộc tính', labelOf('itemName'), 'Kết quả'],
      [
        'Bàn gỗ sồi',
        'Màu: Nâu',
        'Bàn gỗ sồi màu nâu',
        'Tạo hàng hóa "Bàn gỗ sồi" và mặt hàng "Bàn gỗ sồi màu nâu".',
      ],
      [
        'Bàn gỗ sồi',
        'Màu: Trắng',
        'Bàn gỗ sồi màu trắng',
        'Cùng tên hàng hóa với dòng trên: là mặt hàng thứ 2 của "Bàn gỗ sồi", không tạo hàng hóa mới.',
      ],
      [
        'Ghế xoay',
        'Màu: Đen',
        '(bỏ trống)',
        'Tạo hàng hóa "Ghế xoay" và mặt hàng tự đặt tên "Ghế xoay - Đen" (tên hàng hóa kèm giá trị thuộc tính; không có thuộc tính thì trùng tên hàng hóa).',
      ],
    ];
    for (const [i, [name, attribute, itemName, result]] of nameRows.entries()) {
      sheet.mergeCells(row, 2, row, 3);
      sheet.mergeCells(row, 4, row, 5);
      const r = sheet.getRow(row++);
      r.getCell(1).value = name;
      r.getCell(2).value = attribute;
      r.getCell(4).value = itemName;
      r.getCell(6).value = result;
      r.alignment = { wrapText: true, vertical: 'top' };
      if (i === 0) r.font = { bold: true };
    }

    row++;
    sheet.getCell(row, 1).value =
      'VÍ DỤ (một bàn có 2 phiên bản màu, một dịch vụ) - các dòng dưới đây minh hoạ cách điền, không được nhập vào hệ thống:';
    sheet.getCell(row, 1).font = { bold: true };
    row++;
    const example: Record<string, string>[] = [
      {
        name: 'Bàn làm việc gỗ sồi',
        productType: PRODUCT_TYPE_LABELS.PRODUCT,
        status: STATUS_LABELS.ACTIVE,
        isManufacturable: YES,
        sku: 'BAN-SOI-NAU',
        retailPrice: '3500000',
        costPrice: '2400000',
        vat: '10',
        warrantyPeriod: '24 tháng',
        attrName1: 'Màu',
        attrValue1: 'Nâu',
        attrName2: 'Chiều dài',
        attrUnit2: 'cm',
        attrValue2: '120',
      },
      {
        name: 'Bàn làm việc gỗ sồi',
        sku: 'BAN-SOI-TRANG',
        retailPrice: '3600000',
        costPrice: '2450000',
        vat: '10',
        warrantyPeriod: '24 tháng',
        attrName1: 'Màu',
        attrValue1: 'Trắng',
        attrName2: 'Chiều dài',
        attrUnit2: 'cm',
        attrValue2: '120',
      },
      {
        name: 'Lắp đặt tại nhà',
        productType: PRODUCT_TYPE_LABELS.SERVICE,
        retailPrice: '200000',
        costPrice: '0',
      },
    ];
    const exampleHeader = sheet.getRow(row++);
    exampleHeader.values = IMPORT_COLUMNS.map(headerLabel);
    exampleHeader.font = { bold: true };
    for (const values of example) {
      sheet.getRow(row++).values = IMPORT_COLUMNS.map(
        (column) => values[column.key] ?? '',
      );
    }
  }

  // ─── Nhập ───

  /** `actor` null chỉ dùng được khi file không có tồn kho (phiếu điều chỉnh cần người lập). */
  async import(
    tenantId: string,
    file: Express.Multer.File | undefined,
    actor: AuthUser | null = null,
  ): Promise<ImportResult> {
    const locations = await this.stockLocations(tenantId);
    const rows = await this.readFile(file, locations);

    const lookups = await this.loadLookups(tenantId, rows);
    const { products, errors } = parseImportRows(rows, lookups);
    if (errors.length > 0) throw this.rowsInvalid(errors);

    // Kiểm lại bằng DTO của form.
    const dtoErrors: ImportError[] = [];
    for (const product of products) {
      const instance = plainToInstance(CreateProductDto, product.dto);
      const failures = await validate(instance, { whitelist: true });
      for (const message of flattenValidation(failures)) {
        dtoErrors.push({ row: product.rows[0], column: null, message });
      }
    }
    if (dtoErrors.length > 0) throw this.rowsInvalid(dtoErrors);

    const stockLocationIds = new Set(
      products.flatMap((p) => p.itemStock.flat().map((s) => s.locationId)),
    );
    if (stockLocationIds.size > 0) {
      this.assertCanRecordStock(
        actor,
        locations.filter((l) => stockLocationIds.has(l.id)),
      );
    }
    const actorId = actor?.userId ?? null;

    let stockMovementIds: string[] = [];
    const productIds = await this.products.createMany(
      tenantId,
      products.map((product) => product.dto),
      actorId,
      async (tx, itemIds) => {
        const lines = products.flatMap((product, p) =>
          product.itemStock.flatMap((stock, i) =>
            stock.map(({ locationId, quantity }) => ({
              locationId,
              productItemId: itemIds[p][i],
              quantity,
            })),
          ),
        );
        if (lines.length === 0) return;
        stockMovementIds = await this.movements.recordOpeningStock(tx, {
          tenantId,
          // Đã kiểm ở `assertCanRecordStock`: có tồn kho thì có người nhập.
          actorId: actorId!,
          note: OPENING_STOCK_NOTE,
          lines,
        });
      },
    );
    const itemCount = products.reduce((n, p) => n + p.dto.items.length, 0);
    const stockNote =
      stockMovementIds.length > 0
        ? `, ghi tồn kho tại ${stockMovementIds.length} địa điểm`
        : '';
    return {
      message: `Đã nhập ${productIds.length} hàng hóa (${itemCount} mặt hàng)${stockNote}`,
      data: {
        productCount: productIds.length,
        itemCount,
        productIds,
        stockMovementIds,
      },
    };
  }

  /** Ghi tồn = lập và duyệt phiếu điều chỉnh, nên cần đúng quyền và địa điểm như `approve-adjust`. */
  private assertCanRecordStock(
    actor: AuthUser | null,
    locations: StockLocation[],
  ): void {
    if (!actor || !can(actor, 'stock_movement', 'approve')) {
      throw new ForbiddenException({
        code: ErrorCode.PRODUCT_IMPORT_STOCK_DENIED,
        message:
          'Recording opening stock requires the stock_movement:approve permission',
      });
    }
    const denied = locations.filter((location) => !canActAt(actor, location));
    if (denied.length > 0) {
      throw new ForbiddenException({
        code: ErrorCode.PRODUCT_IMPORT_STOCK_DENIED,
        message: `Opening stock names locations outside the caller's posting: ${denied.map((l) => l.name).join(', ')}`,
      });
    }
  }

  private async readFile(
    file: Express.Multer.File | undefined,
    locations: StockLocation[],
  ): Promise<ImportRow[]> {
    if (!file?.buffer?.length) {
      throw fileInvalid('Chưa chọn file');
    }
    if (file.size > MAX_IMPORT_BYTES) {
      throw fileInvalid(
        `File vượt quá ${MAX_IMPORT_BYTES / 1024 / 1024}MB - chia nhỏ file rồi nhập nhiều lần`,
      );
    }
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw fileInvalid(
        'Chỉ nhận file Excel .xlsx - hãy dùng file mẫu tải từ hệ thống (file .xls cũ cần lưu lại dưới dạng .xlsx)',
      );
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw fileInvalid(
        'Không đọc được file - file bị hỏng hoặc không phải Excel .xlsx',
      );
    }
    const sheet = workbook.getWorksheet(IMPORT_SHEET) ?? workbook.worksheets[0];
    if (!sheet) throw fileInvalid('File không có trang tính nào');

    // Dòng 1 là tiêu đề. Nhận cột theo tiêu đề, không theo vị trí - đổi thứ tự cột vẫn đọc đúng.
    const byHeader = new Map(
      IMPORT_COLUMNS.flatMap((column) =>
        [column.header, ...(column.aliases ?? [])].map(
          (header) => [headerKey(header), column] as const,
        ),
      ),
    );
    const columnAt = new Map<number, ImportColumn>();
    const stockAt = new Map<number, Omit<StockCell, 'value'>>();
    const locationIndex = buildNameIndex(
      locations.map((l) => ({ id: l.id, names: [l.name] })),
    );
    const problems: ImportError[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      const header = textOf(cellValue(cell));
      const key = headerKey(header);
      const column = byHeader.get(key);
      const stockLocation = column ? null : stockLocationOf(header);
      if (stockLocation !== null) {
        const ids = locationIndex.get(normalizeName(stockLocation)) ?? [];
        const message =
          ids.length === 0
            ? `Không có kho/chi nhánh "${stockLocation}" trong cửa hàng - tải lại file mẫu để có đúng tên địa điểm`
            : ids.length > 1
              ? `Có ${ids.length} địa điểm cùng tên "${stockLocation}" - đổi tên cho khác nhau rồi tải lại file mẫu`
              : [...stockAt.values()].some((s) => s.locationId === ids[0])
                ? `Cột tồn kho của "${stockLocation}" xuất hiện hai lần`
                : null;
        if (message) {
          problems.push({ row: 1, column: header, message });
        } else {
          stockAt.set(col, { header, locationId: ids[0] });
        }
        return;
      }
      if (!column) return; // cột lạ (ghi chú riêng của người dùng) thì bỏ qua
      if ([...columnAt.values()].includes(column)) {
        problems.push({
          row: 1,
          column: column.header,
          message: `Cột "${column.header}" xuất hiện hai lần`,
        });
        return;
      }
      columnAt.set(col, column);
    });
    if (columnAt.size === 0) {
      throw fileInvalid(
        `Không tìm thấy dòng tiêu đề ở trang "${sheet.name}" - hãy dùng file mẫu tải từ hệ thống`,
      );
    }
    const present = new Set(columnAt.values());
    for (const column of IMPORT_COLUMNS) {
      if (column.required && !present.has(column)) {
        problems.push({
          row: 1,
          column: column.header,
          message: `Thiếu cột bắt buộc "${headerLabel(column)}"`,
        });
      }
    }
    if (problems.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.PRODUCT_IMPORT_FILE_INVALID,
        message: 'The import file does not match the template',
        errors: problems,
      });
    }

    const rows: ImportRow[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cells: ImportRow['cells'] = {};
      let filled = false;
      for (const [col, column] of columnAt) {
        const value = cellValue(row.getCell(col));
        if (textOf(value)) filled = true;
        cells[column.key] = value;
      }
      const stock: StockCell[] = [];
      for (const [col, ref] of stockAt) {
        const value = cellValue(row.getCell(col));
        if (textOf(value)) filled = true;
        stock.push({ ...ref, value });
      }
      // Dòng chỉ có định dạng / dropdown mà không có chữ thì không phải dữ liệu.
      if (filled) rows.push({ rowNumber, cells, stock });
    });
    if (rows.length === 0) {
      throw fileInvalid(`Trang "${sheet.name}" chưa có dòng dữ liệu nào`);
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw fileInvalid(
        `File có ${rows.length} dòng, tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần nhập - chia nhỏ file`,
      );
    }
    return rows;
  }

  /** Mọi thứ bộ đọc cần tra - mỗi loại một truy vấn, rồi làm trong bộ nhớ. */
  private async loadLookups(
    tenantId: string,
    rows: ImportRow[],
  ): Promise<ImportLookups> {
    const skus = unique(
      rows.map((row) => textOf(row.cells.sku)).filter(Boolean),
    );
    const codes = unique(
      rows.map((row) => textOf(row.cells.productCode)).filter(Boolean),
    );
    const barcodes = unique(
      rows.map((row) => textOf(row.cells.barcode)).filter(Boolean),
    );
    const [
      categories,
      brands,
      suppliers,
      products,
      takenSkus,
      takenCodes,
      takenBarcodes,
    ] = await Promise.all([
      this.categoryLabels(tenantId),
      this.prisma.brand.findMany({
        where: { tenantId },
        select: { id: true, name: true },
      }),
      this.prisma.supplier.findMany({
        where: { tenantId },
        select: { id: true, supplierName: true },
      }),
      this.prisma.product.findMany({
        where: { tenantId, status: { not: ProductStatus.DISCONTINUED } },
        select: { name: true },
      }),
      this.prisma.productItem.findMany({
        where: { tenantId, sku: { in: skus } },
        select: { sku: true },
      }),
      this.prisma.productItem.findMany({
        where: { tenantId, productCode: { in: codes } },
        select: { productCode: true },
      }),
      this.prisma.productItem.findMany({
        where: { tenantId, barcode: { in: barcodes } },
        select: { barcode: true },
      }),
    ]);

    return {
      // Một danh mục nhận cả tên lẫn đường dẫn "Cha > Con"; tên trùng ở hai nhánh thì phải dùng đường dẫn.
      categories: buildNameIndex(
        categories.map((c) => ({ id: c.id, names: [c.name, c.path] })),
      ),
      brands: buildNameIndex(
        brands.map((b) => ({ id: b.id, names: [b.name] })),
      ),
      suppliers: buildNameIndex(
        suppliers.map((s) => ({ id: s.id, names: [s.supplierName] })),
      ),
      takenProductNames: new Set(products.map((p) => normalizeName(p.name))),
      takenSkus: new Set(
        takenSkus.map((row) => row.sku).filter((sku): sku is string => !!sku),
      ),
      takenProductCodes: new Set(takenCodes.map((row) => row.productCode)),
      takenBarcodes: new Set(
        takenBarcodes
          .map((row) => row.barcode)
          .filter((code): code is string => !!code),
      ),
    };
  }

  /** Mọi danh mục của cửa hàng kèm đường dẫn "Cha > Con" - nạp một lần, đi cây trong bộ nhớ. */
  async categoryLabels(
    tenantId: string,
  ): Promise<{ id: string; name: string; path: string }[]> {
    const rows = await this.prisma.category.findMany({
      where: { tenantId },
      select: { id: true, name: true, parentId: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const names: string[] = [];
      const seen = new Set<string>();
      for (
        let node: (typeof rows)[number] | undefined = row;
        node && !seen.has(node.id);
        node = node.parentId ? byId.get(node.parentId) : undefined
      ) {
        seen.add(node.id);
        names.unshift(node.name);
      }
      return { id: row.id, name: row.name, path: names.join(' > ') };
    });
  }

  private rowsInvalid(errors: ImportError[]): BadRequestException {
    const rowCount = new Set(errors.map((e) => e.row)).size;
    return new BadRequestException({
      code: ErrorCode.PRODUCT_IMPORT_ROWS_INVALID,
      message: `The import file has ${errors.length} error(s) on ${rowCount} row(s); nothing was created`,
      errors: errors.slice(0, MAX_REPORTED_ERRORS),
      errorCount: errors.length,
    });
  }
}

function fileInvalid(message: string): BadRequestException {
  return new BadRequestException({
    code: ErrorCode.PRODUCT_IMPORT_FILE_INVALID,
    message: 'The import file could not be read',
    errors: [{ row: null, column: null, message }] satisfies ImportError[],
  });
}

function locationLabel(location: StockLocation): string {
  const kind = location.type === LocationType.BRANCH ? 'chi nhánh' : 'kho';
  return `${kind} "${location.name}"`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function flattenValidation(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...flattenValidation(error.children ?? []),
  ]);
}
