import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { ValidationError } from 'class-validator';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import { ErrorCode } from '../../../common/errors/error-codes';
import { LocationStatus } from '../../../common/constants/location-status';
import { ProductStatus } from '../../../common/constants/product-status';
import { SystemRole } from '../../../common/constants/system-role';
import { UserStatus } from '../../../common/constants/user-status';
import {
  buildNameIndex,
  cellValue,
  headerKey,
  textOf,
} from '../../../common/excel/import-cells';
import { profileFullName } from '../../../common/utils/user-profile';
import type { AuthUser } from '../../../common/types/auth-user.type';
import { CreateOrderDto } from '../dto/create-order.dto';
import {
  ManualOrderService,
  type PreparedManualOrder,
} from '../manual-order.service';
import { OrderShortageAlerts } from '../order-shortage-alerts';
import {
  DEPOSIT_METHOD_LABELS,
  FULFILLMENT_LABELS,
  MAX_ORDER_IMPORT_BYTES,
  MAX_ORDER_IMPORT_ORDERS,
  MAX_ORDER_IMPORT_ROWS,
  ORDER_COLUMN_BY_HEADER,
  ORDER_GUIDE_SHEET,
  ORDER_IMPORT_COLUMNS,
  ORDER_IMPORT_SHEET,
  ORDER_LISTS_SHEET,
  PRIORITY_LABELS,
  SAMPLE_GROUP_PREFIX,
  orderHeaderLabel,
} from './order-import.columns';
import type {
  OrderImportColumn,
  OrderImportList,
} from './order-import.columns';
import {
  customerPhoneKey,
  parseOrderImportRows,
  phoneText,
  staffKeys,
} from './order-import.parser';
import type {
  OrderImportError,
  OrderImportLookups,
  OrderImportRow,
} from './order-import.parser';

const MAX_REPORTED_ERRORS = 200;

/** Lỗi của bước kiểm đơn (`ManualOrderService.prepare`), viết lại cho người sửa file. */
const PREPARE_MESSAGES: Partial<Record<string, string>> = {
  [ErrorCode.ORDER_BRANCH_DENIED]:
    'Bạn chỉ nhập được đơn của chi nhánh mình làm việc',
  [ErrorCode.ORDER_ASSIGNEE_INVALID]:
    'Người phụ trách không phải tài khoản đang hoạt động của cửa hàng',
  [ErrorCode.ORDER_ASSIGNEE_WRONG_LOCATION]:
    'Người phụ trách phải làm việc tại chi nhánh của đơn',
  [ErrorCode.ORDER_SELLER_INVALID]:
    'Nhân viên bán hàng không phải tài khoản đang hoạt động của cửa hàng',
  [ErrorCode.ORDER_COMBO_INVALID]: 'Có mặt hàng không bán riêng được',
  [ErrorCode.ORDER_LINE_DISCOUNT_EXCEEDS_TOTAL]:
    'Giảm giá dòng lớn hơn thành tiền của dòng',
  [ErrorCode.ORDER_DEPOSIT_EXCEEDS_TOTAL]: 'Tiền cọc vượt tổng giá trị đơn',
  [ErrorCode.ORDER_PICKUP_NO_SHIPPING_FEE]:
    'Khách đến lấy không có phí giao hàng',
  [ErrorCode.ORDER_DELIVERY_INFO_REQUIRED]:
    'Đơn giao tận nơi cần người nhận, SĐT và địa chỉ giao',
  [ErrorCode.ORDER_SOURCE_LOCATION_INVALID]: 'Kho xuất hàng không hợp lệ',
  [ErrorCode.PRODUCT_ITEM_NOT_FOUND]: 'Có SKU không còn trong cửa hàng',
  [ErrorCode.BRANCH_NOT_FOUND]: 'Không tìm thấy chi nhánh',
  [ErrorCode.CUSTOMER_NOT_FOUND]: 'Không tìm thấy khách hàng',
};

export interface OrderImportResult {
  message: string;
  data: { orderCount: number; orderIds: string[]; codes: string[] };
}

/**
 * Nhập đơn tay từ Excel (2026-11-27), cùng khuôn với nhập hàng hoá: file mẫu theo cửa hàng, cả file đúng mới tạo.
 * Mỗi đơn đi qua đúng `ManualOrderService.prepare` / `write` của `POST /orders`, nên quy tắc không có bản thứ hai:
 * kiểm mọi đơn trước, rồi ghi tất cả trong một transaction.
 */
@Injectable()
export class OrderImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manualOrders: ManualOrderService,
    private readonly shortages: OrderShortageAlerts,
  ) {}

  // ─── File mẫu ───

  async buildTemplate(user: AuthUser, tenantId: string): Promise<Buffer> {
    const [branches, staff, items] = await Promise.all([
      this.prisma.branch.findMany({
        where: {
          tenantId,
          location: { status: LocationStatus.ACTIVE },
          // Nhân viên chỉ nhập đơn chi nhánh mình: danh sách chỉ có chi nhánh đó.
          ...(user.branchId ? { id: user.branchId } : {}),
        },
        select: { id: true, location: { select: { name: true } } },
        orderBy: { location: { name: 'asc' } },
      }),
      this.prisma.user.findMany({
        where: {
          tenantId,
          status: UserStatus.ACTIVE,
          systemRole: { in: [SystemRole.TENANT_OWNER, SystemRole.STAFF] },
        },
        select: {
          phoneNumber: true,
          systemRole: true,
          locationId: true,
          profileFirstName: true,
          profileLastName: true,
        },
      }),
      // Vài mặt hàng đang bán để dựng đơn mẫu bằng chính SKU của cửa hàng.
      this.prisma.productItem.findMany({
        where: {
          tenantId,
          sku: { not: null },
          itemType: 'PRODUCT',
          product: { status: ProductStatus.ACTIVE },
        },
        select: { sku: true, retailPrice: true },
        orderBy: { sku: 'asc' },
        take: 3,
      }),
    ]);
    const staffLabel = (s: (typeof staff)[number]) =>
      `${profileFullName(s) || 'Nhân viên'} - ${s.phoneNumber}`;
    const lists: Record<OrderImportList, string[]> = {
      branches: [...new Set(branches.map((b) => b.location.name))].sort(),
      staff: staff.map(staffLabel).sort(),
      fulfillmentTypes: Object.values(FULFILLMENT_LABELS),
      priorities: Object.values(PRIORITY_LABELS),
      depositMethods: Object.values(DEPOSIT_METHOD_LABELS),
    };

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'iKiot';
    const sheet = workbook.addWorksheet(ORDER_IMPORT_SHEET, {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const guide = workbook.addWorksheet(ORDER_GUIDE_SHEET);
    const listSheet = workbook.addWorksheet(ORDER_LISTS_SHEET);

    const ranges = this.writeLists(listSheet, lists);
    this.writeDataSheet(sheet, ranges);

    // Đơn mẫu bằng dữ liệu thật của cửa hàng: chi nhánh đầu, người phụ trách làm ở đó, SKU đang bán.
    const branch = branches[0];
    const assignee =
      staff.find(
        (s) => s.systemRole === SystemRole.STAFF && s.locationId === branch?.id,
      ) ?? staff.find((s) => s.systemRole === SystemRole.TENANT_OWNER);
    this.writeSamples(sheet, {
      branch: branch?.location.name ?? 'Tên chi nhánh',
      assignee: assignee ? staffLabel(assignee) : 'Tên nhân viên - SĐT',
      skus: items.map((item) => item.sku as string),
    });
    this.writeGuide(guide);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private writeLists(
    sheet: ExcelJS.Worksheet,
    lists: Record<OrderImportList, string[]>,
  ): Partial<Record<OrderImportList, string>> {
    const titles: Record<OrderImportList, string> = {
      branches: 'Chi nhánh',
      staff: 'Nhân viên',
      fulfillmentTypes: 'Hình thức nhận hàng',
      priorities: 'Mức ưu tiên',
      depositMethods: 'Hình thức cọc',
    };
    const ranges: Partial<Record<OrderImportList, string>> = {};
    (Object.keys(titles) as OrderImportList[]).forEach((list, index) => {
      const col = index + 1;
      const letter = sheet.getColumn(col).letter;
      sheet.getColumn(col).width = list === 'staff' ? 36 : 24;
      const header = sheet.getCell(1, col);
      header.value = titles[list];
      header.font = { bold: true };
      lists[list].forEach((value, i) => {
        sheet.getCell(i + 2, col).value = value;
      });
      if (lists[list].length > 0) {
        ranges[list] =
          `'${ORDER_LISTS_SHEET}'!$${letter}$2:$${letter}$${lists[list].length + 1}`;
      }
    });
    sheet.getCell(1, 7).value =
      'Trang này là nguồn cho các ô chọn ở trang "Đơn hàng". Thêm chi nhánh / nhân viên trên hệ thống rồi tải lại file mẫu.';
    sheet.getCell(1, 7).font = { italic: true, color: { argb: 'FF6B7280' } };
    return ranges;
  }

  private writeDataSheet(
    sheet: ExcelJS.Worksheet,
    ranges: Partial<Record<OrderImportList, string>>,
  ): void {
    ORDER_IMPORT_COLUMNS.forEach((column, index) => {
      const col = index + 1;
      sheet.getColumn(col).width = column.width;
      if (column.text) sheet.getColumn(col).numFmt = '@';
      if (column.money) sheet.getColumn(col).numFmt = '#,##0';

      const cell = sheet.getCell(1, col);
      cell.value = orderHeaderLabel(column);
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
            : column.level === 'order'
              ? 'FFDBEAFE'
              : 'FFF3F4F6',
        },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.note = this.noteFor(column);

      const range = column.list ? ranges[column.list] : undefined;
      if (!range) return;
      const validation: ExcelJS.DataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [range],
        // Nhân viên cho gõ số điện thoại thay vì chọn, nên không chặn giá trị ngoài danh sách.
        showErrorMessage: column.list !== 'staff',
        errorStyle: 'stop',
        errorTitle: column.header,
        error: 'Hãy chọn một giá trị trong danh sách.',
      };
      for (let row = 2; row <= MAX_ORDER_IMPORT_ROWS + 1; row++) {
        sheet.getCell(row, col).dataValidation = validation;
      }
    });
    sheet.getRow(1).height = 36;
  }

  /**
   * Hai đơn mẫu ngay trong trang nhập để người dùng thấy cách điền: một đơn giao tận nơi hai mặt hàng có cọc, một đơn
   * khách đến lấy. Chữ nghiêng màu xám và mã nhóm bắt đầu bằng `SAMPLE_GROUP_PREFIX`, mà bộ đọc từ chối.
   */
  private writeSamples(
    sheet: ExcelJS.Worksheet,
    sample: { branch: string; assignee: string; skus: string[] },
  ): void {
    const sku = (i: number) =>
      sample.skus[i] ?? sample.skus[0] ?? 'SKU-MAT-HANG';
    const rows: Partial<Record<OrderImportColumn['key'], string | number>>[] = [
      {
        group: `${SAMPLE_GROUP_PREFIX}1`,
        branch: sample.branch,
        fulfillmentType: FULFILLMENT_LABELS.HOME_DELIVERY,
        assignee: sample.assignee,
        priority: PRIORITY_LABELS.NORMAL,
        customerPhone: '0912345678',
        customerName: 'Nguyễn Văn Mẫu',
        deliveryAddress: '12 Láng Hạ, Đống Đa, Hà Nội',
        shippingFee: 30000,
        deposit: 200000,
        depositMethod: DEPOSIT_METHOD_LABELS.BANK_TRANSFER,
        note: 'Gọi trước khi giao',
        sku: sku(0),
        quantity: 2,
      },
      {
        group: `${SAMPLE_GROUP_PREFIX}1`,
        sku: sku(1),
        quantity: 1,
        lineDiscount: 20000,
      },
      {
        group: `${SAMPLE_GROUP_PREFIX}2`,
        branch: sample.branch,
        fulfillmentType: FULFILLMENT_LABELS.STORE_PICKUP,
        assignee: sample.assignee,
        sku: sku(2),
        quantity: 1,
      },
    ];
    rows.forEach((values, index) => {
      const row = sheet.getRow(index + 2);
      ORDER_IMPORT_COLUMNS.forEach((column, col) => {
        const cell = row.getCell(col + 1);
        cell.value = values[column.key] ?? null;
        cell.font = { italic: true, color: { argb: 'FF6B7280' } };
      });
    });
    sheet.getCell(2, 1).note =
      'Các dòng chữ nghiêng màu xám là ĐƠN MẪU để xem cách điền. Hãy xoá chúng (hoặc ghi đè bằng đơn thật) trước khi nhập - hệ thống không nhận mã nhóm bắt đầu bằng "MẪU-".';
  }

  private noteFor(column: OrderImportColumn): string {
    return [
      column.required ? 'BẮT BUỘC' : 'Không bắt buộc',
      column.level === 'order'
        ? 'Thông tin đơn: chỉ cần điền ở dòng đầu tiên của đơn.'
        : 'Thông tin từng dòng hàng.',
      `Định dạng: ${column.format}`,
      column.note,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private writeGuide(sheet: ExcelJS.Worksheet): void {
    sheet.getColumn(1).width = 24;
    sheet.getColumn(2).width = 11;
    sheet.getColumn(3).width = 14;
    sheet.getColumn(4).width = 30;
    sheet.getColumn(5).width = 26;
    sheet.getColumn(6).width = 70;
    sheet.getCell('A1').value = 'HƯỚNG DẪN NHẬP ĐƠN HÀNG TỪ FILE EXCEL';
    sheet.getCell('A1').font = { bold: true, size: 14 };

    const rules = [
      `Điền dữ liệu ở trang "${ORDER_IMPORT_SHEET}", bắt đầu từ dòng 2. Không đổi tên trang và không sửa dòng tiêu đề.`,
      'Mỗi dòng là một mặt hàng của đơn. Các dòng có cùng "Mã nhóm đơn" là một đơn; mã nhóm chỉ để gom dòng, mã đơn do hệ thống sinh.',
      'Cột tiêu đề màu đỏ có (*) là bắt buộc. Cột màu xanh là thông tin đơn - chỉ cần điền ở dòng đầu của đơn; các dòng sau bỏ trống hoặc ghi giống dòng đầu.',
      'Đơn được tạo ở trạng thái "Xác nhận", giống tạo đơn trên màn hình: chưa giữ hàng, chưa xuất kho. Hàng lấy theo SKU, giá bỏ trống thì lấy giá bán lẻ hiện tại.',
      'Khách hàng khớp theo số điện thoại; chưa có thì tạo khách mới (cần tên). Bỏ trống cả SĐT lẫn tên là khách vãng lai.',
      'Giao tận nơi cần người nhận, SĐT người nhận và địa chỉ; bỏ trống người nhận / SĐT thì lấy theo khách. Khách đến lấy không có phí giao hàng.',
      'Tiền cọc là tiền đã thu: ghi vào sổ thu chi ngay khi nhập. Không nhập khuyến mãi và đơn may theo số đo - làm trên màn hình đơn sau khi nhập.',
      `Tối đa ${MAX_ORDER_IMPORT_ROWS} dòng và ${MAX_ORDER_IMPORT_ORDERS} đơn mỗi lần, file .xlsx không quá ${MAX_ORDER_IMPORT_BYTES / 1024 / 1024}MB.`,
      'Hệ thống kiểm tra toàn bộ file trước khi tạo: chỉ cần một dòng sai là không có đơn nào được tạo, mọi lỗi được liệt kê theo dòng để sửa một lần.',
      `Trang "${ORDER_IMPORT_SHEET}" có sẵn vài đơn mẫu (chữ nghiêng màu xám, mã nhóm "${SAMPLE_GROUP_PREFIX}1", "${SAMPLE_GROUP_PREFIX}2") dùng chính chi nhánh, nhân viên và SKU của cửa hàng. Xoá các dòng này hoặc ghi đè bằng đơn thật trước khi nhập.`,
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
    const header = sheet.getRow(row++);
    header.values = [
      'Cột',
      'Bắt buộc',
      'Áp dụng cho',
      'Định dạng',
      'Ví dụ',
      'Ghi chú',
    ];
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1F2937' },
      };
    });
    for (const column of ORDER_IMPORT_COLUMNS) {
      const r = sheet.getRow(row++);
      r.values = [
        orderHeaderLabel(column),
        column.required ? 'Có' : '',
        column.level === 'order' ? 'Đơn' : 'Từng dòng hàng',
        column.format,
        column.example,
        column.note,
      ];
      r.alignment = { wrapText: true, vertical: 'top' };
      if (column.required) {
        r.getCell(1).font = { bold: true, color: { argb: 'FFDC2626' } };
      }
    }

    row++;
    sheet.getCell(row++, 1).value =
      'VÍ DỤ (đơn DH1 hai mặt hàng giao tận nơi có cọc, đơn DH2 khách đến lấy) - minh hoạ cách điền, không được nhập vào hệ thống:';
    sheet.getCell(row - 1, 1).font = { bold: true };
    const example: Partial<Record<OrderImportColumn['key'], string>>[] = [
      {
        group: 'DH1',
        branch: 'CN Hà Nội',
        fulfillmentType: FULFILLMENT_LABELS.HOME_DELIVERY,
        assignee: 'Nguyễn Văn A - 0901234567',
        customerPhone: '0912345678',
        customerName: 'Trần Thị B',
        deliveryAddress: '12 Láng Hạ, Đống Đa, Hà Nội',
        shippingFee: '50000',
        deposit: '1000000',
        depositMethod: DEPOSIT_METHOD_LABELS.CASH,
        sku: 'BAN-SOI-NAU',
        quantity: '1',
      },
      { group: 'DH1', sku: 'GHE-XOAY-DEN', quantity: '2', unitPrice: '800000' },
      {
        group: 'DH2',
        branch: 'CN Hà Nội',
        fulfillmentType: FULFILLMENT_LABELS.STORE_PICKUP,
        assignee: 'Nguyễn Văn A - 0901234567',
        sku: 'BAN-SOI-TRANG',
        quantity: '1',
      },
    ];
    sheet.getRow(row++).values = ORDER_IMPORT_COLUMNS.map(orderHeaderLabel);
    sheet.getRow(row - 1).font = { bold: true };
    for (const values of example) {
      sheet.getRow(row++).values = ORDER_IMPORT_COLUMNS.map(
        (column) => values[column.key] ?? '',
      );
    }
  }

  // ─── Nhập ───

  async import(
    user: AuthUser,
    tenantId: string,
    file: Express.Multer.File | undefined,
  ): Promise<OrderImportResult> {
    const rows = await this.readFile(file);
    const lookups = await this.loadLookups(tenantId, rows);
    const { orders, errors } = parseOrderImportRows(rows, lookups);
    if (errors.length > 0) throw rowsInvalid(errors);
    if (orders.length > MAX_ORDER_IMPORT_ORDERS) {
      throw fileInvalid(
        `File có ${orders.length} đơn, tối đa ${MAX_ORDER_IMPORT_ORDERS} đơn mỗi lần nhập - chia nhỏ file`,
      );
    }

    // Kiểm bằng DTO của `POST /orders`, rồi bằng đúng bước kiểm của tạo đơn.
    const prepared: { rows: number[]; order: PreparedManualOrder }[] = [];
    const problems: OrderImportError[] = [];
    for (const order of orders) {
      const instance = plainToInstance(CreateOrderDto, order.dto);
      const failures = await validate(instance, { whitelist: true });
      if (failures.length > 0) {
        for (const message of flattenValidation(failures)) {
          problems.push({ row: order.rows[0], column: null, message });
        }
        continue;
      }
      try {
        prepared.push({
          rows: order.rows,
          order: await this.manualOrders.prepare(user, tenantId, instance),
        });
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        problems.push({
          row: order.rows[0],
          column: null,
          message: `Đơn "${order.group}": ${prepareMessage(error)}`,
        });
      }
    }
    if (problems.length > 0) throw rowsInvalid(problems);

    // Khách mới tạo trước transaction (như tạo đơn trên form); hai đơn cùng SĐT dùng chung một khách.
    const customerIds: (string | undefined)[] = [];
    for (const { order } of prepared) {
      customerIds.push(
        await this.manualOrders.resolveTypedInCustomer(tenantId, order.dto),
      );
    }
    const shortage = await this.shortages.snapshot(
      tenantId,
      prepared.flatMap(({ order }) => order.items),
    );

    const orderIds = await this.prisma.$transaction(
      async (tx) => {
        const ids: string[] = [];
        for (const [index, { order }] of prepared.entries()) {
          ids.push(
            await this.manualOrders.write(
              tx,
              user,
              tenantId,
              order,
              customerIds[index],
            ),
          );
        }
        return ids;
      },
      { timeout: 120_000 },
    );

    // Một lần cho cả file: snapshot chung nên mỗi SKU chuyển sang thiếu chỉ báo một lần.
    await this.shortages.notify(tenantId, orderIds[0], shortage, user.userId);
    const codes = (
      await this.prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, code: true },
      })
    )
      .sort((a, b) => orderIds.indexOf(a.id) - orderIds.indexOf(b.id))
      .map((o) => o.code);

    return {
      message: `Đã nhập ${orderIds.length} đơn hàng`,
      data: { orderCount: orderIds.length, orderIds, codes },
    };
  }

  private async readFile(
    file: Express.Multer.File | undefined,
  ): Promise<OrderImportRow[]> {
    if (!file?.buffer?.length) throw fileInvalid('Chưa chọn file');
    if (file.size > MAX_ORDER_IMPORT_BYTES) {
      throw fileInvalid(
        `File vượt quá ${MAX_ORDER_IMPORT_BYTES / 1024 / 1024}MB - chia nhỏ file rồi nhập nhiều lần`,
      );
    }
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw fileInvalid(
        'Chỉ nhận file Excel .xlsx - hãy dùng file mẫu tải từ hệ thống',
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
    const sheet =
      workbook.getWorksheet(ORDER_IMPORT_SHEET) ?? workbook.worksheets[0];
    if (!sheet) throw fileInvalid('File không có trang tính nào');

    // Nhận cột theo tiêu đề, không theo vị trí.
    const columnAt = new Map<number, OrderImportColumn>();
    const problems: OrderImportError[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      const column = ORDER_COLUMN_BY_HEADER.get(
        headerKey(textOf(cellValue(cell))),
      );
      if (!column) return;
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
        `Không tìm thấy dòng tiêu đề ở trang "${sheet.name}" - hãy dùng file mẫu nhập đơn hàng tải từ hệ thống`,
      );
    }
    const present = new Set(columnAt.values());
    for (const column of ORDER_IMPORT_COLUMNS) {
      if (column.required && !present.has(column)) {
        problems.push({
          row: 1,
          column: column.header,
          message: `Thiếu cột bắt buộc "${orderHeaderLabel(column)}"`,
        });
      }
    }
    if (problems.length > 0) {
      throw new BadRequestException({
        code: ErrorCode.ORDER_IMPORT_FILE_INVALID,
        message: 'The import file does not match the template',
        errors: problems,
      });
    }

    const rows: OrderImportRow[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cells: OrderImportRow['cells'] = {};
      let filled = false;
      for (const [col, column] of columnAt) {
        const value = cellValue(row.getCell(col));
        if (textOf(value)) filled = true;
        cells[column.key] = value;
      }
      if (filled) rows.push({ rowNumber, cells });
    });
    if (rows.length === 0) {
      throw fileInvalid(`Trang "${sheet.name}" chưa có dòng dữ liệu nào`);
    }
    if (rows.length > MAX_ORDER_IMPORT_ROWS) {
      throw fileInvalid(
        `File có ${rows.length} dòng, tối đa ${MAX_ORDER_IMPORT_ROWS} dòng mỗi lần nhập - chia nhỏ file`,
      );
    }
    return rows;
  }

  /** Mọi thứ bộ đọc cần tra - mỗi loại một truy vấn. */
  private async loadLookups(
    tenantId: string,
    rows: OrderImportRow[],
  ): Promise<OrderImportLookups> {
    const skus = [
      ...new Set(rows.map((r) => textOf(r.cells.sku)).filter(Boolean)),
    ];
    const [branches, staff, items] = await Promise.all([
      this.prisma.branch.findMany({
        where: { tenantId, location: { status: LocationStatus.ACTIVE } },
        select: { id: true, location: { select: { name: true } } },
      }),
      this.prisma.user.findMany({
        where: {
          tenantId,
          status: UserStatus.ACTIVE,
          systemRole: { in: [SystemRole.TENANT_OWNER, SystemRole.STAFF] },
        },
        select: {
          id: true,
          phoneNumber: true,
          profileFirstName: true,
          profileLastName: true,
        },
      }),
      this.prisma.productItem.findMany({
        where: { tenantId, sku: { in: skus } },
        select: {
          id: true,
          sku: true,
          product: { select: { status: true } },
        },
      }),
    ]);

    const staffIndex = new Map<string, string[]>();
    for (const person of staff) {
      for (const key of staffKeys(
        profileFullName(person) || 'Nhân viên',
        person.phoneNumber,
      )) {
        const ids = staffIndex.get(key) ?? [];
        if (!ids.includes(person.id)) ids.push(person.id);
        staffIndex.set(key, ids);
      }
    }

    const phones = [
      ...new Set(
        rows
          .map((r) => customerPhoneKey(phoneText(r.cells.customerPhone)))
          .filter(Boolean),
      ),
    ];
    const customers = phones.length
      ? await this.prisma.customer.findMany({
          where: { tenantId, isDeleted: false, phone: { in: phones } },
          select: { id: true, name: true, phone: true },
        })
      : [];

    return {
      branches: buildNameIndex(
        branches.map((b) => ({ id: b.id, names: [b.location.name] })),
      ),
      staff: staffIndex,
      items: new Map(
        items
          .filter((item) => item.sku)
          .map((item) => [
            item.sku as string,
            {
              id: item.id,
              sellable: item.product.status === ProductStatus.ACTIVE,
            },
          ]),
      ),
      customersByPhone: new Map(
        customers
          .filter((c) => c.phone)
          .map((c) => [
            customerPhoneKey(c.phone),
            { id: c.id, name: c.name, phone: c.phone ?? '' },
          ]),
      ),
    };
  }
}

function prepareMessage(error: HttpException): string {
  const body = error.getResponse();
  const code =
    typeof body === 'object' && body !== null && 'code' in body
      ? String(body.code)
      : '';
  return (
    PREPARE_MESSAGES[code] ?? `Không tạo được đơn (${code || error.message})`
  );
}

function rowsInvalid(errors: OrderImportError[]): BadRequestException {
  const rowCount = new Set(errors.map((e) => e.row)).size;
  return new BadRequestException({
    code: ErrorCode.ORDER_IMPORT_ROWS_INVALID,
    message: `The import file has ${errors.length} error(s) on ${rowCount} row(s); nothing was created`,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorCount: errors.length,
  });
}

function fileInvalid(message: string): BadRequestException {
  return new BadRequestException({
    code: ErrorCode.ORDER_IMPORT_FILE_INVALID,
    message: 'The import file could not be read',
    errors: [{ row: null, column: null, message }] satisfies OrderImportError[],
  });
}

function flattenValidation(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...flattenValidation(error.children ?? []),
  ]);
}
