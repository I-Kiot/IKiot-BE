import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../../common/types/auth-user.type';
import { requireTenantId } from '../../../common/utils/tenant-scope';
import { VIETNAM_TIMEZONE } from '../../../common/constants/timezone';
import { SalesJournalEntryType } from '../../../common/constants/sales-journal';
import { StatsService } from '../stats.service';
import { StatsReportsService } from '../stats-reports.service';
import {
  businessDatesOf,
  previousBusinessDates,
  vietnamDateOf,
} from '../stats-math';
import { GroupBy, TopProductsSort } from '../stats.constants';
import {
  CashflowQueryDto,
  InventoryStatsQueryDto,
  ReportExportQueryDto,
  RevenueByStaffQueryDto,
  RevenueSeriesQueryDto,
  SalesJournalExportQueryDto,
  StatsQueryDto,
  TopCustomersQueryDto,
  TopProductsQueryDto,
} from '../dto/stats-query.dto';
import {
  CellValue,
  LEDGER_SIGNERS,
  REPORT_SIGNERS,
  ReportSheet,
  ReportUnit,
  TT99_LEGAL_NOTE,
  formatDateVi,
  longDateVi,
  newWorkbook,
  toBuffer,
} from './report-sheet';
import {
  cashFlowCategoryLabel,
  fundLabel,
  orderStatusLabel,
  paymentMethodLabel,
  sepayOutcomeLabel,
} from './report-labels';

export interface ExportedFile {
  buffer: Buffer;
  filename: string;
}

type JournalRow = Awaited<
  ReturnType<StatsReportsService['getSalesJournalForExport']>
>[number];

const ENTRY_LABEL: Record<string, string> = {
  [SalesJournalEntryType.SALE]: 'Bán hàng',
  [SalesJournalEntryType.RETURN]: 'Hàng bán bị trả lại',
  [SalesJournalEntryType.OTHER_INCOME]: 'Thu nhập khác (tiền giữ lại)',
};

/** Sheet của từng báo cáo (tab) trên trang; `section` của file xuất giữ lại đúng các sheet này. */
const SECTION_SHEETS: Record<string, { sheets: string[]; slug: string }> = {
  result: { sheets: ['Kết quả bán hàng'], slug: 'ket-qua-ban-hang' },
  time: { sheets: ['Theo thời gian'], slug: 'doanh-thu-theo-thoi-gian' },
  product: { sheets: ['Theo hàng hóa'], slug: 'doanh-thu-theo-hang-hoa' },
  branch: { sheets: ['Theo chi nhánh'], slug: 'doanh-thu-theo-chi-nhanh' },
  staff: { sheets: ['Theo nhân viên'], slug: 'doanh-thu-theo-nhan-vien' },
  customer: { sheets: ['Khách hàng'], slug: 'doanh-thu-theo-khach-hang' },
  orders: { sheets: ['Trạng thái đơn'], slug: 'don-hang-theo-trang-thai' },
  cash: { sheets: ['Phương thức thanh toán', 'Thu chi'], slug: 'thu-chi' },
  inventory: { sheets: ['Tồn kho'], slug: 'ton-kho' },
};

const STAFF_TITLE: Record<string, string> = {
  assignee: 'BÁO CÁO DOANH THU THEO NHÂN VIÊN PHỤ TRÁCH',
  creator: 'BÁO CÁO DOANH THU THEO NHÂN VIÊN LÊN ĐƠN',
  collector: 'BÁO CÁO TIỀN THỰC THU THEO NHÂN VIÊN THU TIỀN',
};

/** Số dòng tối đa của sheet khách hàng và hàng hóa: giới hạn của `/stats/top-customers`, cùng số với bảng trên trang. */
const TOP_CUSTOMERS_IN_EXPORT = 50;

/**
 * Dựng file Excel cho ba trang báo cáo. Không tính lại số nào: mọi con số lấy từ đúng hàm mà màn hình gọi (`StatsService`, `StatsReportsService`), nên file và màn hình không thể lệch nhau.
 * Sổ doanh thu trình bày theo hai mẫu sổ của Thông tư 99/2025/TT-BTC (S03a4-DN, S35-DN); hai báo cáo còn lại không có mẫu quy định nên dùng cùng khung trình bày, không ghi số hiệu mẫu.
 */
@Injectable()
export class StatsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: StatsService,
    private readonly reports: StatsReportsService,
  ) {}

  private async unitOf(user: AuthUser): Promise<ReportUnit> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: requireTenantId(user) },
      select: { name: true, mainAddress: true, taxNumber: true },
    });
    return {
      name: tenant?.name ?? '',
      address: tenant?.mainAddress ?? null,
      taxNumber: tenant?.taxNumber ?? null,
    };
  }

  /** Tên địa điểm đang lọc, để ghi dưới tên sổ; không lọc thì là toàn cửa hàng. */
  private async placeLabel(user: AuthUser, id?: string): Promise<string> {
    if (!id) return 'Toàn cửa hàng';
    const location = await this.prisma.location.findFirst({
      where: { id, tenantId: user.tenantId ?? undefined },
      select: { name: true },
    });
    return location?.name ?? 'Toàn cửa hàng';
  }

  // ---------------------------------------------------------------- Sổ doanh thu

  /** Sổ doanh thu: sheet 1 Sổ nhật ký bán hàng (S03a4-DN), sheet 2 Sổ chi tiết bán hàng (S35-DN). */
  async salesJournal(
    user: AuthUser,
    query: SalesJournalExportQueryDto,
  ): Promise<ExportedFile> {
    const [unit, rows, place] = await Promise.all([
      this.unitOf(user),
      this.reports.getSalesJournalForExport(user, query),
      this.placeLabel(user, query.branchId),
    ]);
    const period = businessDatesOf(query.range());
    const periodLine = `Từ ngày ${formatDateVi(period.from)} đến ngày ${formatDateVi(period.to)} - ${place}`;
    const today = vietnamDateOf(new Date());

    const workbook = newWorkbook();
    this.writeSalesDaybook(
      new ReportSheet(
        workbook.addWorksheet('S03a4-DN'),
        [13, 16, 13, 44, 18, 18, 16, 16, 16],
      ),
      unit,
      rows,
      periodLine,
      period.from,
      today,
    );
    this.writeSalesDetail(
      new ReportSheet(
        workbook.addWorksheet('S35-DN'),
        [13, 16, 13, 44, 10, 10, 15, 17, 12, 20],
      ),
      unit,
      rows,
      periodLine,
      period.from,
      today,
    );
    return {
      buffer: await toBuffer(workbook),
      filename: `so-doanh-thu_${period.from}_${period.to}.xlsx`,
    };
  }

  /** Mẫu S03a4-DN. Cột 5 "Thu nhập khác" là cột thêm (khoản 2 Điều 12 cho phép bổ sung): tiền giữ lại khi huỷ / trả hàng không phải doanh thu bán hàng nhưng có trong sổ doanh thu của hệ thống. */
  private writeSalesDaybook(
    out: ReportSheet,
    unit: ReportUnit,
    rows: JournalRow[],
    periodLine: string,
    openedOn: string,
    today: string,
  ) {
    out.unitHeader(unit, { code: 'S03a4-DN', legalNote: TT99_LEGAL_NOTE });
    out.title('SỔ NHẬT KÝ BÁN HÀNG', [periodLine, 'Đơn vị tính: đồng']);
    out.tableHeader(
      [
        { label: 'Ngày, tháng ghi sổ' },
        { label: 'Chứng từ', children: ['Số hiệu', 'Ngày, tháng'] },
        { label: 'Diễn giải' },
        { label: 'Phải thu từ người mua (Ghi Nợ)' },
        {
          label: 'Ghi Có tài khoản doanh thu',
          children: ['Hàng hoá', 'Thành phẩm', 'Dịch vụ'],
        },
        { label: 'Thu nhập khác' },
      ],
      ['A', 'B', 'C', 'D', '1', '2', '3', '4', '5'],
    );

    const sum = { total: 0, goods: 0, service: 0, other: 0 };
    for (const row of rows) {
      const description = [
        ENTRY_LABEL[row.entryType] ?? row.entryType,
        row.customerName ? `- ${row.customerName}` : '',
      ]
        .join(' ')
        .trim();
      out.dataRow(
        [
          formatDateVi(row.postedDate),
          row.orderCode,
          formatDateVi(row.businessDate),
          description,
          row.totalAmount,
          row.goodsAmount,
          null,
          row.shippingAmount,
          row.otherIncomeAmount,
        ],
        { center: [0, 1, 2] },
      );
      sum.total += row.totalAmount;
      sum.goods += row.goodsAmount;
      sum.service += row.shippingAmount;
      sum.other += row.otherIncomeAmount;
    }
    if (rows.length === 0) out.emptyRow();
    out.dataRow(
      [
        null,
        null,
        null,
        'Cộng số phát sinh',
        sum.total,
        sum.goods,
        null,
        sum.service,
        sum.other,
      ],
      { bold: true },
    );

    out.blank();
    out.note(
      '- Cột "Dịch vụ" là phí vận chuyển thu của khách. Hàng bán bị trả lại ghi số âm vào ngày trả hàng.',
    );
    out.note(`- Ngày mở sổ: ${formatDateVi(openedOn)}`, false);
    out.signatures(longDateVi(today), LEDGER_SIGNERS);
  }

  /**
   * Mẫu S35-DN. Mẫu gốc mở một sổ cho mỗi sản phẩm; ở đây gộp mọi mặt hàng vào một sổ và ghi tên hàng ở cột Diễn giải.
   * Hàng trả ghi ở cột 5 (số dương); "TK đối ứng" và "Thuế" để trống vì hệ thống không hạch toán tài khoản và không tách thuế trên sổ doanh thu.
   */
  private writeSalesDetail(
    out: ReportSheet,
    unit: ReportUnit,
    rows: JournalRow[],
    periodLine: string,
    openedOn: string,
    today: string,
  ) {
    out.unitHeader(unit, { code: 'S35-DN', legalNote: TT99_LEGAL_NOTE });
    out.title('SỔ CHI TIẾT BÁN HÀNG', [
      'Tên sản phẩm (hàng hóa, dịch vụ, bất động sản đầu tư): Tất cả hàng hóa',
      periodLine,
      'Đơn vị tính: đồng',
    ]);
    out.tableHeader(
      [
        { label: 'Ngày, tháng ghi sổ' },
        { label: 'Chứng từ', children: ['Số hiệu', 'Ngày, tháng'] },
        { label: 'Diễn giải' },
        { label: 'TK đối ứng' },
        {
          label: 'Doanh thu',
          children: ['Số lượng', 'Đơn giá', 'Thành tiền'],
        },
        {
          label: 'Các khoản tính trừ',
          children: [
            'Thuế',
            'Các khoản chiết khấu thương mại, giảm giá hàng bán, hàng bán bị trả lại',
          ],
        },
      ],
      ['A', 'B', 'C', 'D', 'E', '1', '2', '3', '4', '5'],
    );

    let revenue = 0;
    let deductions = 0;
    let costOfGoods = 0;
    let lineCount = 0;
    for (const row of rows) {
      const isReturn = row.entryType === SalesJournalEntryType.RETURN;
      for (const line of row.lines) {
        const quantity = Math.abs(line.quantity);
        const amount = Math.abs(line.amount);
        const name = [line.productName, line.sku ? `(${line.sku})` : '']
          .join(' ')
          .trim();
        out.dataRow(
          [
            formatDateVi(row.postedDate),
            row.orderCode,
            formatDateVi(row.businessDate),
            isReturn ? `Hàng bán bị trả lại: ${name}` : name,
            null,
            quantity,
            quantity > 0 ? Math.round(amount / quantity) : null,
            isReturn ? null : amount,
            null,
            isReturn ? amount : null,
          ],
          { center: [0, 1, 2] },
        );
        if (isReturn) deductions += amount;
        else revenue += amount;
        // Giá vốn có dấu: dòng trả hàng mang số âm, nên cộng thẳng ra giá vốn của hàng thực bán.
        costOfGoods += line.cogs;
        lineCount += 1;
      }
    }
    if (lineCount === 0) out.emptyRow();

    const netRevenue = revenue - deductions;
    const footer = (label: string, value: number | null, bold = false) =>
      out.dataRow(
        [null, null, null, label, null, null, null, value, null, null],
        { bold },
      );
    out.dataRow(
      [
        null,
        null,
        null,
        'Cộng số phát sinh',
        null,
        null,
        null,
        revenue,
        null,
        deductions,
      ],
      { bold: true },
    );
    footer('- Doanh thu thuần', netRevenue);
    footer('- Giá vốn hàng bán', costOfGoods);
    footer('- Lãi gộp', netRevenue - costOfGoods, true);

    out.blank();
    out.note(
      '- Sổ chỉ gồm tiền hàng; phí vận chuyển thu của khách và thu nhập khác xem ở Sổ nhật ký bán hàng (S03a4-DN).',
    );
    out.note(`- Ngày mở sổ: ${formatDateVi(openedOn)}`, false);
    out.signatures(longDateVi(today), LEDGER_SIGNERS);
  }

  // ---------------------------------------------------------------- Đối soát tiền

  /** Báo cáo đối soát tiền tại thời điểm xuất: mỗi mục trên màn hình là một bảng. */
  async unreconciled(user: AuthUser, branchId?: string): Promise<ExportedFile> {
    const [unit, data, place] = await Promise.all([
      this.unitOf(user),
      this.reports.getUnreconciled(user, branchId),
      this.placeLabel(user, branchId),
    ]);
    const today = vietnamDateOf(data.asOf);
    const time = data.asOf.toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: VIETNAM_TIMEZONE,
    });

    const workbook = newWorkbook();
    const out = new ReportSheet(
      workbook.addWorksheet('Đối soát tiền'),
      [6, 34, 24, 20, 18, 18],
    );
    out.unitHeader(unit);
    out.title('BÁO CÁO ĐỐI SOÁT TIỀN', [
      `Tại thời điểm ${time} ngày ${formatDateVi(today)} - ${place}`,
      'Đơn vị tính: đồng',
    ]);

    /** Một bảng của báo cáo: tiêu đề mục, đầu bảng 6 cột (cột thừa để trống), các dòng, dòng cộng. */
    const section = (
      label: string,
      headers: string[],
      rows: CellValue[][],
      total?: CellValue[],
    ) => {
      out.heading(label);
      out.tableHeader(
        ['STT', ...headers].map((header) => ({ label: header })),
        undefined,
        false,
      );
      rows.forEach((row, index) =>
        out.dataRow([index + 1, ...row], { center: [0] }),
      );
      if (rows.length === 0) out.emptyRow('Không có khoản nào');
      if (total) out.dataRow([null, ...total], { bold: true });
      out.blank();
    };
    const dateOf = (at: Date | null) =>
      at ? formatDateVi(vietnamDateOf(at)) : null;

    section(
      'I. Tiền mặt shipper đang giữ (khách đã trả, chưa nộp về)',
      ['Shipper', 'Số đơn', 'Khoản cũ nhất', 'Số tiền', ''],
      data.shipperCash.items.map((item) => [
        item.collectorName ?? 'Không rõ',
        item.orderCount,
        dateOf(item.oldestPaidAt),
        item.amount,
      ]),
      ['Cộng', data.shipperCash.orderCount, null, data.shipperCash.amount],
    );
    section(
      'II. Giao dịch SePay chưa xử lý',
      ['Kết quả', 'Mã đơn', 'Ngày', 'Số tiền', 'Trong đó trả dư'],
      data.sepayExceptions.items.map((item) => [
        sepayOutcomeLabel(item.outcome),
        item.orderCode,
        dateOf(item.createdAt),
        item.amount,
        item.excessAmount,
      ]),
      [
        `Cộng (${data.sepayExceptions.count} giao dịch)`,
        null,
        null,
        data.sepayExceptions.amount,
        data.sepayExceptions.excessAmount,
      ],
    );
    section(
      'III. Đơn thu dư tiền (cần hoàn phần dư)',
      ['Mã đơn', 'Giá trị đơn', 'Thu dư', '', ''],
      data.overpaidOrders.items.map((item) => [
        item.code,
        item.grandTotal,
        item.overpaidBy,
      ]),
      [
        `Cộng (${data.overpaidOrders.count} đơn)`,
        null,
        data.overpaidOrders.amount,
      ],
    );
    section(
      'IV. Tiền giữ treo chưa quyết định (đơn đã huỷ / trả hàng)',
      ['Mã đơn', 'Trạng thái', 'Ngày kết thúc', 'Tiền đang giữ', ''],
      data.heldUndecided.items.map((item) => [
        item.code,
        orderStatusLabel(item.status),
        dateOf(item.closedAt),
        item.held,
      ]),
      [
        `Cộng (${data.heldUndecided.count} đơn)`,
        null,
        null,
        data.heldUndecided.amount,
      ],
    );
    if (data.unallocatedBank) {
      section(
        'V. Tiền về ngân hàng chưa gắn đơn',
        ['Chỉ tiêu', 'Số tiền', '', '', ''],
        [
          ['Tiền về', data.unallocatedBank.receipts],
          ['Đã hoàn', data.unallocatedBank.refunds],
        ],
        ['Còn lại', data.unallocatedBank.net],
      );
    }
    section(
      'VI. Quỹ chủ (tiền không đi qua két chi nhánh)',
      ['Khoản mục', 'Số lần', 'Thu', 'Chi', ''],
      data.ownerFund.byCategory.map((row) => [
        cashFlowCategoryLabel(row.category),
        row.count,
        row.flowType === 'INCOME' ? row.amount : null,
        row.flowType === 'EXPENSE' ? row.amount : null,
      ]),
      ['Cộng', null, data.ownerFund.income, data.ownerFund.expense],
    );
    out.row -= 1;
    out.dataRow([null, 'Số dư quỹ chủ', null, data.ownerFund.balance], {
      bold: true,
    });
    out.blank();
    section(
      'VII. Tiền mặt thu tại quầy kho (không nằm trong két nào)',
      ['Kho', 'Thu', 'Chi', 'Còn lại', ''],
      data.warehouseCounterCash.items.map((item) => [
        item.locationName,
        item.income,
        item.expense,
        item.net,
      ]),
      ['Cộng', null, null, data.warehouseCounterCash.net],
    );
    section(
      'VIII. Hoàn tiền mặt trừ vào két chi nhánh (két sẽ hụt đúng số này)',
      ['Nơi đặt két', 'Số lần', 'Số tiền', '', ''],
      data.cashRefundsAgainstDrawer.items.map((item) => [
        item.locationName,
        item.count,
        item.amount,
      ]),
      [
        'Cộng',
        data.cashRefundsAgainstDrawer.count,
        data.cashRefundsAgainstDrawer.amount,
      ],
    );

    if (data.journalCoverage.ordersWithoutJournal > 0) {
      out.note(
        `Ghi chú: ${data.journalCoverage.ordersWithoutJournal} đơn hoàn tất trước khi có sổ doanh thu chưa được tính vào doanh thu và lợi nhuận.`,
      );
    }
    out.signatures(longDateVi(today), REPORT_SIGNERS);
    return {
      buffer: await toBuffer(workbook),
      filename: `doi-soat-tien_${today}.xlsx`,
    };
  }

  // ---------------------------------------------------------------- Báo cáo chi tiết

  /** File của trang Báo cáo chi tiết: mỗi nhóm số liệu trên trang là một sheet, cùng bộ lọc kỳ và địa điểm. */
  async report(
    user: AuthUser,
    query: ReportExportQueryDto,
  ): Promise<ExportedFile> {
    // Cùng cách trang báo cáo gọi: báo cáo đơn hàng lọc theo nơi đang xem (id chi nhánh và kho dùng chung), thu chi và tồn kho phân biệt kho với chi nhánh.
    const place = query.branchId ?? query.warehouseId;
    const dates = { fromDate: query.fromDate, toDate: query.toDate };
    const orderQuery = Object.assign(new StatsQueryDto(), {
      ...dates,
      branchId: place,
    });
    const cashQuery = Object.assign(
      new CashflowQueryDto(),
      query.warehouseId
        ? { ...dates, warehouseId: query.warehouseId }
        : { ...dates, branchId: query.branchId, flow: 'ORD' },
    );
    const inventoryQuery = Object.assign(new InventoryStatsQueryDto(), {
      branchId: query.branchId,
      warehouseId: query.warehouseId,
      lowStockThreshold: query.lowStockThreshold,
    });
    const period = businessDatesOf(query.range());
    // Kỳ trước: cùng số ngày, liền ngay trước kỳ đang xem (cùng cách trang báo cáo tính).
    const previous = previousBusinessDates(period);
    const previousQuery = Object.assign(new StatsQueryDto(), {
      fromDate: previous.from,
      toDate: previous.to,
      branchId: place,
    });

    const [
      unit,
      placeName,
      overview,
      previousOverview,
      series,
      products,
      byBranch,
      byStaff,
      customers,
      byMethod,
      byStatus,
      cashflow,
      inventory,
    ] = await Promise.all([
      this.unitOf(user),
      this.placeLabel(user, place),
      this.stats.getOverview(user, orderQuery),
      this.stats.getOverview(user, previousQuery),
      this.stats.getRevenueSeries(
        user,
        Object.assign(new RevenueSeriesQueryDto(), orderQuery, {
          groupBy: query.groupBy ?? GroupBy.DAY,
        }),
      ),
      this.stats.getTopProducts(
        user,
        Object.assign(new TopProductsQueryDto(), orderQuery, {
          sortBy: TopProductsSort.REVENUE,
          limit: TOP_CUSTOMERS_IN_EXPORT,
        }),
      ),
      this.stats.getRevenueByBranch(user, orderQuery),
      this.stats.getRevenueByStaff(
        user,
        Object.assign(new RevenueByStaffQueryDto(), orderQuery, {
          groupBy: query.staffGroupBy,
        }),
      ),
      this.stats.getTopCustomers(
        user,
        Object.assign(new TopCustomersQueryDto(), orderQuery, {
          limit: TOP_CUSTOMERS_IN_EXPORT,
        }),
      ),
      this.stats.getRevenueByPaymentMethod(user, orderQuery),
      this.stats.getOrdersByStatus(user, orderQuery),
      this.stats.getCashflow(user, cashQuery),
      this.stats.getInventory(user, inventoryQuery),
    ]);

    const periodLine = `Từ ngày ${formatDateVi(period.from)} đến ngày ${formatDateVi(period.to)} - ${placeName}`;
    const today = vietnamDateOf(new Date());
    const workbook = newWorkbook();

    /** Một sheet một bảng: đầu trang, tên báo cáo, bảng có STT, dòng cộng, chữ ký. */
    const sheet = (
      name: string,
      title: string,
      subtitle: string,
      headers: string[],
      widths: number[],
      rows: CellValue[][],
      total?: CellValue[],
      extra?: (out: ReportSheet) => void,
    ) => {
      const out = new ReportSheet(workbook.addWorksheet(name), [6, ...widths]);
      out.unitHeader(unit);
      out.title(title, [subtitle, 'Đơn vị tính: đồng']);
      out.tableHeader(['STT', ...headers].map((header) => ({ label: header })));
      rows.forEach((row, index) =>
        out.dataRow([index + 1, ...row], { center: [0] }),
      );
      if (rows.length === 0) out.emptyRow();
      if (total) out.dataRow([null, ...total], { bold: true });
      extra?.(out);
      out.signatures(longDateVi(today), REPORT_SIGNERS);
    };
    const sumOf = <T>(items: T[], pick: (item: T) => number) =>
      items.reduce((n, item) => n + pick(item), 0);

    // 1. Kết quả bán hàng, đặt cạnh kỳ trước
    const result = new ReportSheet(
      workbook.addWorksheet('Kết quả bán hàng'),
      [6, 46, 20, 20, 20],
    );
    result.unitHeader(unit);
    result.title('BÁO CÁO KẾT QUẢ BÁN HÀNG', [
      periodLine,
      `Kỳ trước: từ ngày ${formatDateVi(previous.from)} đến ngày ${formatDateVi(previous.to)}`,
      'Đơn vị tính: đồng',
    ]);
    result.tableHeader(
      ['STT', 'Chỉ tiêu', 'Kỳ này', 'Kỳ trước', 'Chênh lệch'].map((label) => ({
        label,
      })),
    );
    type Overview = typeof overview;
    const lines: [string, (o: Overview) => number, boolean?][] = [
      [
        'Doanh thu bán hàng (tiền hàng + phí vận chuyển thu khách)',
        (o) => o.grossSales,
      ],
      ['Hàng bán bị trả lại', (o) => o.returns],
      ['Thu nhập khác (tiền giữ lại khi huỷ / trả hàng)', (o) => o.otherIncome],
      ['Doanh thu thuần', (o) => o.revenue, true],
      ['Giá vốn hàng bán', (o) => o.costOfGoods],
      ['Chi phí vận chuyển thực', (o) => o.shippingCost],
      ['Phí sàn', (o) => o.channelFee],
      ['Lợi nhuận gộp', (o) => o.grossProfit, true],
      ['Số đơn hoàn tất', (o) => o.orderCount],
      ['Số đơn có hàng trả', (o) => o.returnCount],
      ['Số khách mua hàng', (o) => o.customerCount],
      ['Giá trị đơn trung bình', (o) => o.aov],
    ];
    lines.forEach(([label, pick, bold], index) => {
      const current = pick(overview);
      const before = pick(previousOverview);
      result.dataRow([index + 1, label, current, before, current - before], {
        bold,
        center: [0],
      });
    });
    if (overview.linesMissingCost > 0) {
      result.blank();
      result.note(
        `Ghi chú: ${overview.linesMissingCost} dòng hàng đã bán chưa có giá vốn nên lợi nhuận gộp đang cao hơn thực tế.`,
      );
    }
    result.signatures(longDateVi(today), REPORT_SIGNERS);

    // 2. Doanh thu theo thời gian: chỉ các mốc có phát sinh
    const byMonth = query.groupBy === GroupBy.MONTH;
    sheet(
      'Theo thời gian',
      byMonth ? 'BÁO CÁO DOANH THU THEO THÁNG' : 'BÁO CÁO DOANH THU THEO NGÀY',
      periodLine,
      [byMonth ? 'Tháng' : 'Ngày', 'Số đơn', 'Hàng trả', 'Doanh thu thuần'],
      [18, 12, 20, 22],
      series.series.map((point) => [
        byMonth
          ? `${point.bucket.slice(5, 7)}/${point.bucket.slice(0, 4)}`
          : formatDateVi(point.bucket),
        point.orderCount,
        point.returns,
        point.revenue,
      ]),
      [
        'Cộng',
        sumOf(series.series, (p) => p.orderCount),
        sumOf(series.series, (p) => p.returns),
        sumOf(series.series, (p) => p.revenue),
      ],
    );

    // 3. Doanh thu theo hàng hóa
    sheet(
      'Theo hàng hóa',
      `BÁO CÁO DOANH THU THEO HÀNG HÓA (${TOP_CUSTOMERS_IN_EXPORT} MẶT HÀNG DOANH THU CAO NHẤT)`,
      periodLine,
      ['Hàng hóa', 'Số lượng bán', 'Doanh thu'],
      [46, 14, 22],
      products.products.map((p) => [p.productName, p.quantity, p.revenue]),
      [
        'Cộng',
        sumOf(products.products, (p) => p.quantity),
        sumOf(products.products, (p) => p.revenue),
      ],
    );

    // 4-6. Doanh thu theo chi nhánh, nhân viên, khách hàng
    const revenueHeaders = [
      'Số đơn',
      'Doanh thu thuần',
      'Giá trị đơn trung bình',
    ];
    sheet(
      'Theo chi nhánh',
      'BÁO CÁO DOANH THU THEO CHI NHÁNH',
      periodLine,
      ['Chi nhánh', ...revenueHeaders],
      [36, 12, 20, 22],
      byBranch.branches.map((b) => [
        b.branchName ?? 'Không rõ',
        b.orderCount,
        b.revenue,
        b.aov,
      ]),
      [
        'Cộng',
        sumOf(byBranch.branches, (b) => b.orderCount),
        sumOf(byBranch.branches, (b) => b.revenue),
        null,
      ],
    );
    sheet(
      'Theo nhân viên',
      STAFF_TITLE[query.staffGroupBy] ?? STAFF_TITLE.assignee,
      periodLine,
      ['Nhân viên', ...revenueHeaders],
      [36, 12, 20, 22],
      byStaff.staff.map((s) => [
        s.staffName ?? 'Không gắn nhân viên',
        s.orderCount,
        s.revenue,
        s.aov,
      ]),
      [
        'Cộng',
        sumOf(byStaff.staff, (s) => s.orderCount),
        sumOf(byStaff.staff, (s) => s.revenue),
        null,
      ],
    );
    sheet(
      'Khách hàng',
      `BÁO CÁO DOANH THU THEO KHÁCH HÀNG (${TOP_CUSTOMERS_IN_EXPORT} KHÁCH MUA NHIỀU NHẤT)`,
      periodLine,
      ['Khách hàng', 'Số điện thoại', ...revenueHeaders],
      [34, 16, 12, 20, 22],
      customers.customers.map((c) => [
        c.name ?? 'Không rõ',
        c.phone,
        c.orderCount,
        c.revenue,
        c.aov,
      ]),
    );

    // 5. Tiền thực thu theo phương thức
    sheet(
      'Phương thức thanh toán',
      'BÁO CÁO TIỀN THỰC THU THEO PHƯƠNG THỨC THANH TOÁN',
      periodLine,
      ['Phương thức', 'Số đơn', 'Đã thu', 'Đã hoàn', 'Tiền thối', 'Thực thu'],
      [26, 12, 18, 18, 18, 18],
      byMethod.breakdown.map((m) => [
        paymentMethodLabel(m.paymentMethod),
        m.orderCount,
        m.received,
        m.refunded,
        m.change,
        m.revenue,
      ]),
      [
        'Cộng',
        null,
        sumOf(byMethod.breakdown, (m) => m.received),
        sumOf(byMethod.breakdown, (m) => m.refunded),
        sumOf(byMethod.breakdown, (m) => m.change),
        sumOf(byMethod.breakdown, (m) => m.revenue),
      ],
    );

    // 6. Đơn hàng theo trạng thái
    sheet(
      'Trạng thái đơn',
      'BÁO CÁO ĐƠN HÀNG THEO TRẠNG THÁI',
      periodLine,
      ['Trạng thái', 'Số đơn', 'Giá trị đơn'],
      [30, 14, 22],
      byStatus.statuses.map((s) => [
        orderStatusLabel(s.status),
        s.count,
        s.total,
      ]),
      ['Cộng', byStatus.totalCount, sumOf(byStatus.statuses, (s) => s.total)],
    );

    // 7. Thu chi theo quỹ và khoản mục
    const cash = new ReportSheet(
      workbook.addWorksheet('Thu chi'),
      [6, 30, 30, 12, 18, 18, 18],
    );
    cash.unitHeader(unit);
    cash.title('BÁO CÁO THU CHI THEO QUỸ', [periodLine, 'Đơn vị tính: đồng']);
    cash.tableHeader(
      ['STT', 'Quỹ', 'Khoản mục', 'Số lần', 'Thu', 'Chi', 'Chênh lệch'].map(
        (label) => ({ label }),
      ),
    );
    cashflow.byCategory.forEach((row, index) => {
      const income = row.flowType === 'INCOME' ? row.total : null;
      const expense = row.flowType === 'EXPENSE' ? row.total : null;
      cash.dataRow(
        [
          index + 1,
          fundLabel(row.fund),
          cashFlowCategoryLabel(row.category),
          row.count,
          income,
          expense,
          null,
        ],
        { center: [0] },
      );
    });
    if (cashflow.byCategory.length === 0) cash.emptyRow();
    for (const fund of cashflow.byFund) {
      cash.dataRow(
        [
          null,
          `Cộng ${fundLabel(fund.fund)}`,
          null,
          fund.count,
          fund.income,
          fund.expense,
          fund.net,
        ],
        { italic: true },
      );
    }
    cash.dataRow(
      [
        null,
        'Tổng cộng',
        null,
        null,
        cashflow.income,
        cashflow.expense,
        cashflow.net,
      ],
      { bold: true },
    );
    cash.signatures(longDateVi(today), REPORT_SIGNERS);

    // 8. Tồn kho tại thời điểm xuất
    sheet(
      'Tồn kho',
      'BÁO CÁO TỒN KHO',
      `Tại ngày ${formatDateVi(today)} - ${placeName}`,
      ['Chỉ tiêu', 'Giá trị'],
      [44, 22],
      [
        ['Giá trị hàng tồn kho (theo giá vốn)', inventory.stockValue],
        ['Tổng số lượng tồn', inventory.totalUnits],
        ['Số mặt hàng (SKU) đang có tồn', inventory.skuCount],
        ['Số mặt hàng hết hàng', inventory.outOfStock],
        [
          `Số mặt hàng sắp hết (tồn từ ${inventory.lowStockThreshold} trở xuống)`,
          inventory.lowStock.length,
        ],
      ],
      undefined,
      (stock) => {
        if (inventory.lowStock.length === 0) return;
        stock.blank();
        stock.heading('Danh sách mặt hàng sắp hết');
        stock.tableHeader(
          ['STT', 'Tên hàng (mã hàng)', 'Số lượng tồn'].map((label) => ({
            label,
          })),
          undefined,
          false,
        );
        inventory.lowStock.forEach((item, index) =>
          stock.dataRow(
            [index + 1, `${item.productName} (${item.sku})`, item.stock],
            { center: [0] },
          ),
        );
      },
    );

    // Xuất một báo cáo: dựng đủ rồi bỏ các sheet khác, để một sheet xuất riêng và sheet đó trong file tổng luôn là cùng một đoạn code.
    const section = query.section ? SECTION_SHEETS[query.section] : undefined;
    if (section) {
      for (const worksheet of [...workbook.worksheets]) {
        if (!section.sheets.includes(worksheet.name))
          workbook.removeWorksheet(worksheet.id);
      }
    }
    return {
      buffer: await toBuffer(workbook),
      filename: `${section?.slug ?? 'bao-cao-ban-hang'}_${period.from}_${period.to}.xlsx`,
    };
  }
}
