import { BadRequestException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import { ErrorCode } from '../../../common/errors/error-codes';
import { ProductStatus } from '../../../common/constants/product-status';
import { ProductService } from '../products.service';
import { CreateProductDto } from '../dto/create-product.dto';
import {
  GUIDE_SHEET,
  IMPORT_COLUMNS,
  IMPORT_SHEET,
  ITEM_TYPE_LABELS,
  LISTS_SHEET,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  NO,
  STATUS_LABELS,
  YES,
  headerKey,
  headerLabel,
} from './product-import.columns';
import type { ImportColumn, ImportList } from './product-import.columns';
import {
  buildNameIndex,
  normalizeName,
  parseImportRows,
  textOf,
} from './product-import.parser';
import type {
  CellValue,
  ImportError,
  ImportLookups,
  ImportRow,
} from './product-import.parser';

/** Lỗi trả về tối đa - một file hỏng toàn bộ không cần liệt kê 5000 dòng giống nhau. */
const MAX_REPORTED_ERRORS = 200;

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export interface ImportResult {
  message: string;
  data: { productCount: number; itemCount: number; productIds: string[] };
}

/**
 * Nhập hàng hoá từ Excel. Cả file đúng mới tạo, sai một dòng là không tạo gì: một nửa danh mục
 * đã vào, nửa kia không, thì người dùng phải tự dò xem dòng nào đã có để khỏi nhập trùng.
 * Việc tạo đi qua `ProductService.createMany` - cùng đường với form "Thêm hàng hóa", nên quota,
 * mã tự sinh, SKU trùng, danh mục/thương hiệu/NCC đều được kiểm tra lại ở đó.
 */
@Injectable()
export class ProductImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductService,
  ) {}

  // ─── Template ──────────────────────────────────────────────────────────────

  /** Template theo cửa hàng: dropdown danh mục, thương hiệu, NCC lấy từ dữ liệu hiện có. */
  async buildTemplate(tenantId: string): Promise<Buffer> {
    const [categories, brands, suppliers] = await Promise.all([
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
    ]);
    const lists: Record<ImportList, string[]> = {
      categories: categories.map((c) => c.path).sort(),
      brands: unique(brands.map((b) => b.name)),
      suppliers: unique(suppliers.map((s) => s.supplierName)),
      statuses: Object.values(STATUS_LABELS),
      itemTypes: Object.values(ITEM_TYPE_LABELS),
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
    this.writeDataSheet(sheet, listRanges);
    this.writeGuide(guide);

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
      itemTypes: 'Loại mặt hàng',
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
  ): void {
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
      for (let row = 2; row <= MAX_IMPORT_ROWS + 1; row++) {
        sheet.getCell(row, col).dataValidation = validation;
      }
    });
    sheet.getRow(1).height = 36;
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

  private writeGuide(sheet: ExcelJS.Worksheet): void {
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
      'Mã hàng và SKU có thể bỏ trống để hệ thống tự sinh. SKU không được trùng trong file và với SKU đã có.',
      'File chỉ tạo hàng hóa mới: tên hàng hóa trùng với hàng đã có trong cửa hàng sẽ bị báo lỗi. Tồn kho không nhập ở đây - hàng vào kho qua phiếu nhập.',
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

    // Hai cột tên dễ bị hiểu là "điền một trong hai": thực ra mỗi dòng luôn tạo một mặt hàng, và
    // "Tên hàng hóa" chỉ quyết định mặt hàng đó thuộc hàng hóa nào.
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
        retailPrice: '200000',
        costPrice: '0',
        itemType: ITEM_TYPE_LABELS.SERVICE,
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

  // ─── Import ────────────────────────────────────────────────────────────────

  async import(
    tenantId: string,
    file: Express.Multer.File | undefined,
  ): Promise<ImportResult> {
    const rows = await this.readFile(file);

    const lookups = await this.loadLookups(tenantId, rows);
    const { products, errors } = parseImportRows(rows, lookups);
    if (errors.length > 0) throw this.rowsInvalid(errors);

    // Lưới an toàn: bộ đọc đã kiểm hết, nhưng DTO của form là luật gốc - một luật thêm vào DTO
    // sau này phải chặn được cả file import mà không ai nhớ sửa bộ đọc.
    const dtoErrors: ImportError[] = [];
    for (const product of products) {
      const instance = plainToInstance(CreateProductDto, product.dto);
      const failures = await validate(instance, { whitelist: true });
      for (const message of flattenValidation(failures)) {
        dtoErrors.push({ row: product.rows[0], column: null, message });
      }
    }
    if (dtoErrors.length > 0) throw this.rowsInvalid(dtoErrors);

    const productIds = await this.products.createMany(
      tenantId,
      products.map((product) => product.dto),
    );
    const itemCount = products.reduce((n, p) => n + p.dto.items.length, 0);
    return {
      message: `Đã nhập ${productIds.length} hàng hóa (${itemCount} mặt hàng)`,
      data: { productCount: productIds.length, itemCount, productIds },
    };
  }

  private async readFile(
    file: Express.Multer.File | undefined,
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
      IMPORT_COLUMNS.map((column) => [headerKey(column.header), column]),
    );
    const columnAt = new Map<number, ImportColumn>();
    const problems: ImportError[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      const key = headerKey(textOf(cellValue(cell)));
      const column = byHeader.get(key);
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
      // Dòng chỉ có định dạng / dropdown mà không có chữ thì không phải dữ liệu.
      if (filled) rows.push({ rowNumber, cells });
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
    const [categories, brands, suppliers, products, takenSkus] =
      await Promise.all([
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
    };
  }

  /** Mọi danh mục của cửa hàng kèm đường dẫn "Cha > Con" - nạp một lần, đi cây trong bộ nhớ. */
  private async categoryLabels(
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Giá trị thật của một ô exceljs: công thức lấy kết quả, chữ định dạng / hyperlink lấy chữ. */
function cellValue(cell: ExcelJS.Cell): CellValue {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('formula' in value || 'sharedFormula' in value) {
    const result = (value as ExcelJS.CellFormulaValue).result;
    if (result === undefined || result === null) return null;
    if (typeof result === 'object' && !(result instanceof Date)) return null; // #N/A...
    return result;
  }
  if ('hyperlink' in value) {
    const text = value.text as unknown;
    if (typeof text === 'string') return text;
    if (text && typeof text === 'object' && 'richText' in text) {
      return (text as ExcelJS.CellRichTextValue).richText
        .map((r) => r.text)
        .join('');
    }
    return value.hyperlink;
  }
  if ('error' in value) return null;
  return textOf(String(value));
}

function flattenValidation(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...flattenValidation(error.children ?? []),
  ]);
}
