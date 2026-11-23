import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../../common/types/auth-user.type';
import { VIETNAM_TIMEZONE } from '../../../common/constants/timezone';
import { StatsService } from '../stats.service';
import { StatsReportsService } from '../stats-reports.service';
import {
  businessDatesOf,
  dateBuckets,
  previousBusinessDates,
  vietnamDateOf,
  type BusinessDateRange,
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
  ReportSheet,
  formatDateVi,
  newWorkbook,
  shareOf,
  toBuffer,
} from './report-sheet';
import {
  cashFlowCategoryLabel,
  fundLabel,
  journalEntryTypeLabel,
  journalSourceLabel,
  orderStatusLabel,
  paymentMethodLabel,
  sepayOutcomeLabel,
} from './report-labels';

export interface ExportedFile {
  buffer: Buffer;
  filename: string;
}

/** Tên file của từng báo cáo (cùng tên FE đặt khi lưu). */
const SECTION_SLUG: Record<string, string> = {
  result: 'ket-qua-ban-hang',
  time: 'doanh-thu-theo-thoi-gian',
  product: 'doanh-thu-theo-hang-hoa',
  branch: 'doanh-thu-theo-diem-ban',
  staff: 'doanh-thu-theo-nhan-vien',
  customer: 'doanh-thu-theo-khach-hang',
  orders: 'don-hang-theo-trang-thai',
  cash: 'thu-chi',
  inventory: 'ton-kho',
};

/**
 * Các tab của trang Báo cáo tổng hợp, theo thứ tự tab - "Xuất tất cả" ở đó gồm đúng các báo cáo này.
 * `branch` (so sánh các điểm bán) chỉ có khi xem toàn cửa hàng, như tab trên web; nhân viên có trang và nút xuất riêng.
 */
const SUMMARY_SECTIONS = [
  'result',
  'time',
  'product',
  'branch',
  'customer',
  'orders',
  'cash',
  'inventory',
];

/** Mô tả của bảng theo nhân viên, cùng câu chữ với ô chọn "Tính theo" trên trang. */
const STAFF_DESCRIPTION: Record<string, string> = {
  assignee:
    'Doanh thu thuần theo người phụ trách đơn (đơn quầy tính cho người lên đơn)',
  creator: 'Doanh thu thuần theo người tạo đơn',
  collector:
    'Tiền thực thu theo người thu (ngày thu tiền, không phải ngày hoàn thành đơn)',
};

const REVENUE_NOTE =
  'Doanh thu thuần ghi theo ngày đơn hoàn thành, đã trừ hàng trả.';

/** Số dòng tối đa của bảng khách hàng và hàng hóa: cùng số với bảng trên trang. */
const TOP_IN_EXPORT = 50;

const sumOf = <T>(items: T[], pick: (item: T) => number) =>
  items.reduce((n, item) => n + pick(item), 0);

/** Ngày giờ Việt Nam `dd/mm/yyyy HH:mm`, như `formatDateTime` trên web. */
function dateTimeVi(at: Date | string | null): string | null {
  if (!at) return null;
  const date = typeof at === 'string' ? new Date(at) : at;
  const time = date.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: VIETNAM_TIMEZONE,
  });
  return `${formatDateVi(vietnamDateOf(date))} ${time}`;
}

const periodText = ({ from, to }: BusinessDateRange) =>
  `${formatDateVi(from)} – ${formatDateVi(to)}`;

/** Bộ lọc dùng chung khi dựng các sheet của một file báo cáo. */
interface ReportContext {
  user: AuthUser;
  query: ReportExportQueryDto;
  workbook: ExcelJS.Workbook;
  period: BusinessDateRange;
  /** "Từ ngày ... đến ngày ... - <nơi>", dòng phụ dưới tên mỗi báo cáo. */
  periodLine: string;
  placeName: string;
  /** Query của các báo cáo đơn hàng / doanh thu (lọc theo nơi đang xem, id chi nhánh và kho dùng chung). */
  orderQuery: StatsQueryDto;
}

/**
 * Dựng file Excel cho các trang báo cáo. Mỗi sheet là đúng bảng trên trang web: cùng cột, cùng thứ tự, cùng dòng tổng (chốt 2026-11-23).
 * Không tính lại số nào: mọi con số lấy từ đúng hàm mà màn hình gọi (`StatsService`, `StatsReportsService`), nên file và màn hình không thể lệch nhau.
 */
@Injectable()
export class StatsExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: StatsService,
    private readonly reports: StatsReportsService,
  ) {}

  /** Tên địa điểm đang lọc, để ghi dưới tên báo cáo; không lọc thì là toàn cửa hàng. */
  private async placeLabel(user: AuthUser, id?: string): Promise<string> {
    if (!id) return 'Toàn cửa hàng';
    const location = await this.prisma.location.findFirst({
      where: { id, tenantId: user.tenantId ?? undefined },
      select: { name: true },
    });
    return location?.name ?? 'Toàn cửa hàng';
  }

  // ---------------------------------------------------------------- Sổ doanh thu

  /** Sổ doanh thu: sheet 1 là bảng bút toán như trên trang, sheet 2 là các dòng hàng (phần mở rộng của mỗi bút toán trên trang). */
  async salesJournal(
    user: AuthUser,
    query: SalesJournalExportQueryDto,
  ): Promise<ExportedFile> {
    const [rows, place] = await Promise.all([
      this.reports.getSalesJournalForExport(user, query),
      this.placeLabel(user, query.branchId),
    ]);
    const period = businessDatesOf(query.range());
    const periodLine = `Từ ngày ${formatDateVi(period.from)} đến ngày ${formatDateVi(period.to)} - ${place}`;
    const workbook = newWorkbook();

    const entries = new ReportSheet(
      workbook.addWorksheet('Sổ doanh thu'),
      [12, 14, 14, 22, 22, 16, 14, 16, 16, 16],
    );
    entries.title('Sổ doanh thu', [periodLine]);
    entries.tableHeader(
      [
        'Ngày',
        'Loại',
        'Đơn hàng',
        'Chi nhánh',
        'Nguồn',
        'Tiền hàng',
        'Vận chuyển',
        'Thu nhập khác',
        'Tổng',
        'Giá vốn',
      ],
      [5, 6, 7, 8, 9],
    );
    for (const row of rows) {
      entries.dataRow([
        formatDateVi(row.businessDate),
        journalEntryTypeLabel(row.entryType),
        row.orderCode,
        row.branchName ?? '-',
        journalSourceLabel(row.source),
        row.goodsAmount,
        row.shippingAmount,
        row.otherIncomeAmount,
        row.totalAmount,
        row.cogsAmount,
      ]);
    }
    if (rows.length === 0) entries.emptyRow('Không có dữ liệu');
    entries.dataRow(
      [
        'Tổng cộng',
        null,
        null,
        null,
        null,
        sumOf(rows, (r) => r.goodsAmount),
        sumOf(rows, (r) => r.shippingAmount),
        sumOf(rows, (r) => r.otherIncomeAmount),
        sumOf(rows, (r) => r.totalAmount),
        sumOf(rows, (r) => r.cogsAmount),
      ],
      { strong: true },
    );
    entries.blank();
    entries.note(
      'Doanh thu ghi theo ngày đơn hoàn thành; hàng trả ghi âm vào ngày trả. Đơn cũ trước khi có sổ không nằm ở đây.',
    );

    const lines = new ReportSheet(
      workbook.addWorksheet('Dòng hàng'),
      [12, 14, 40, 16, 12, 16, 16],
    );
    lines.title('Sổ doanh thu - dòng hàng', [periodLine]);
    lines.tableHeader(
      [
        'Ngày',
        'Đơn hàng',
        'Sản phẩm',
        'SKU',
        'Số lượng',
        'Thành tiền',
        'Giá vốn',
      ],
      [4, 5, 6],
    );
    const allLines = rows.flatMap((row) =>
      row.lines.map((line) => ({ row, line })),
    );
    for (const { row, line } of allLines) {
      lines.dataRow([
        formatDateVi(row.businessDate),
        row.orderCode,
        line.productName ?? '-',
        line.sku ?? '-',
        line.quantity,
        line.amount,
        line.cogs,
      ]);
    }
    if (allLines.length === 0) lines.emptyRow('Không có dữ liệu');
    lines.dataRow(
      [
        'Tổng cộng',
        null,
        null,
        null,
        sumOf(allLines, (l) => l.line.quantity),
        sumOf(allLines, (l) => l.line.amount),
        sumOf(allLines, (l) => l.line.cogs),
      ],
      { strong: true },
    );

    return {
      buffer: await toBuffer(workbook),
      filename: `so-doanh-thu_${period.from}_${period.to}.xlsx`,
    };
  }

  // ---------------------------------------------------------------- Đối soát tiền

  /** Đối soát tiền tại thời điểm xuất: mỗi mục trên màn hình là một bảng cùng cột, dòng cộng là con số tổng ở góc mục. */
  async unreconciled(user: AuthUser, branchId?: string): Promise<ExportedFile> {
    const [data, place] = await Promise.all([
      this.reports.getUnreconciled(user, branchId),
      this.placeLabel(user, branchId),
    ]);
    const today = vietnamDateOf(data.asOf);

    const workbook = newWorkbook();
    const out = new ReportSheet(
      workbook.addWorksheet('Đối soát tiền'),
      [34, 18, 22, 18],
    );
    out.title('Đối soát tiền', [
      `Tại thời điểm ${dateTimeVi(data.asOf)} - ${place}`,
    ]);

    /** Một mục: tiêu đề, đầu bảng, các dòng, dòng cộng. `numeric` là các cột số (căn phải). */
    const section = (
      label: string,
      headers: string[],
      numeric: number[],
      rows: CellValue[][],
      totals: CellValue[][],
      emptyText: string,
    ) => {
      out.heading(label);
      out.tableHeader(headers, numeric);
      rows.forEach((row) => out.dataRow(row));
      if (rows.length === 0) out.emptyRow(emptyText, headers.length);
      totals.forEach((row) => out.dataRow(row, { strong: true }));
      out.blank();
    };

    section(
      'Tiền mặt shipper đang giữ',
      ['Shipper', 'Số đơn', 'Cũ nhất', 'Số tiền'],
      [1, 3],
      data.shipperCash.items.map((item) => [
        item.collectorName ?? 'Không rõ',
        item.orderCount,
        dateTimeVi(item.oldestPaidAt),
        item.amount,
      ]),
      [['Cộng', data.shipperCash.orderCount, null, data.shipperCash.amount]],
      'Không có shipper nào đang giữ tiền.',
    );
    section(
      'Giao dịch SePay chưa xử lý',
      ['Kết quả', 'Đơn', 'Thời gian', 'Số tiền'],
      [3],
      data.sepayExceptions.items.map((item) => [
        sepayOutcomeLabel(item.outcome),
        item.orderCode ?? '-',
        dateTimeVi(item.createdAt),
        item.amount,
      ]),
      [
        [
          `Cộng (${data.sepayExceptions.count} dòng)`,
          null,
          null,
          data.sepayExceptions.amount,
        ],
        ...(data.sepayExceptions.excessAmount > 0
          ? [['Trong đó trả dư', null, null, data.sepayExceptions.excessAmount]]
          : []),
      ],
      'Không có giao dịch nào cần xử lý.',
    );
    section(
      'Đơn thu dư tiền',
      ['Đơn', 'Giá trị đơn', 'Thu dư'],
      [1, 2],
      data.overpaidOrders.items.map((item) => [
        item.code,
        item.grandTotal,
        item.overpaidBy,
      ]),
      [
        [
          `Cộng (${data.overpaidOrders.count} đơn)`,
          null,
          data.overpaidOrders.amount,
        ],
      ],
      'Không có đơn nào thu dư.',
    );
    section(
      'Tiền giữ treo chưa quyết định',
      ['Đơn', 'Trạng thái', 'Kết thúc lúc', 'Tiền đang giữ'],
      [3],
      data.heldUndecided.items.map((item) => [
        item.code,
        item.status === 'CANCELLED' ? 'Đã huỷ' : 'Đã trả hàng',
        dateTimeVi(item.closedAt),
        item.held,
      ]),
      [
        [
          `Cộng (${data.heldUndecided.count} đơn)`,
          null,
          null,
          data.heldUndecided.amount,
        ],
      ],
      'Không có khoản tiền giữ treo nào.',
    );
    if (data.unallocatedBank) {
      section(
        'Tiền về ngân hàng chưa gắn đơn',
        ['Chỉ tiêu', 'Số tiền'],
        [1],
        [
          ['Tiền về', data.unallocatedBank.receipts],
          ['Đã hoàn', data.unallocatedBank.refunds],
        ],
        [['Còn lại', data.unallocatedBank.net]],
        '',
      );
    }
    section(
      'Quỹ chủ',
      ['Khoản mục', 'Số lần', 'Tiền vào', 'Tiền ra'],
      [1, 2, 3],
      data.ownerFund.byCategory.map((row) => [
        cashFlowCategoryLabel(row.category),
        row.count,
        row.flowType === 'INCOME' ? row.amount : null,
        row.flowType === 'EXPENSE' ? row.amount : null,
      ]),
      [
        ['Cộng', null, data.ownerFund.income, data.ownerFund.expense],
        ['Số dư quỹ chủ', null, data.ownerFund.balance, null],
      ],
      'Không có khoản nào.',
    );
    section(
      'Tiền mặt tại quầy kho',
      ['Kho', 'Thu', 'Chi', 'Ròng'],
      [1, 2, 3],
      data.warehouseCounterCash.items.map((item) => [
        item.locationName,
        item.income,
        item.expense,
        item.net,
      ]),
      [['Cộng', null, null, data.warehouseCounterCash.net]],
      'Không có khoản nào.',
    );
    section(
      'Hoàn tiền mặt trừ vào két chi nhánh',
      ['Nơi đặt két', 'Số lần', 'Số tiền'],
      [1, 2],
      data.cashRefundsAgainstDrawer.items.map((item) => [
        item.locationName,
        item.count,
        item.amount,
      ]),
      [
        [
          'Cộng',
          data.cashRefundsAgainstDrawer.count,
          data.cashRefundsAgainstDrawer.amount,
        ],
      ],
      'Không có khoản nào.',
    );

    if (data.journalCoverage.ordersWithoutJournal > 0) {
      out.note(
        `Ghi chú: ${data.journalCoverage.ordersWithoutJournal} đơn hoàn tất trước khi có sổ doanh thu chưa được tính vào doanh thu và lợi nhuận.`,
      );
    }
    return {
      buffer: await toBuffer(workbook),
      filename: `doi-soat-tien_${today}.xlsx`,
    };
  }

  // ---------------------------------------------------------------- Báo cáo

  /**
   * File của các trang Báo cáo: `section` là một báo cáo (một tab của trang Tổng hợp, hoặc trang Nhân viên / Điểm bán);
   * bỏ trống là mọi tab của trang Tổng hợp, mỗi báo cáo một sheet. Chỉ lấy số liệu của các báo cáo được xuất.
   */
  async report(
    user: AuthUser,
    query: ReportExportQueryDto,
  ): Promise<ExportedFile> {
    const place = query.branchId ?? query.warehouseId;
    const period = businessDatesOf(query.range());
    const placeName = await this.placeLabel(user, place);
    const ctx: ReportContext = {
      user,
      query,
      workbook: newWorkbook(),
      period,
      periodLine: `Từ ngày ${formatDateVi(period.from)} đến ngày ${formatDateVi(period.to)} - ${placeName}`,
      placeName,
      orderQuery: Object.assign(new StatsQueryDto(), {
        fromDate: query.fromDate,
        toDate: query.toDate,
        branchId: place,
      }),
    };

    const builders: Record<string, (ctx: ReportContext) => Promise<void>> = {
      result: (c) => this.resultSheet(c),
      time: (c) => this.timeSheet(c),
      product: (c) => this.productSheet(c),
      branch: (c) => this.branchSheet(c),
      staff: (c) => this.staffSheet(c),
      customer: (c) => this.customerSheet(c),
      orders: (c) => this.ordersSheet(c),
      cash: (c) => this.cashSheets(c),
      inventory: (c) => this.inventorySheets(c),
    };
    // Tuần tự để thứ tự sheet đúng thứ tự tab; mỗi builder tự gọi song song phần của nó.
    const sections = query.section
      ? [query.section]
      : SUMMARY_SECTIONS.filter((section) => section !== 'branch' || !place);
    for (const section of sections) await builders[section](ctx);

    const slug = query.section
      ? SECTION_SLUG[query.section]
      : 'bao-cao-tong-hop';
    return {
      buffer: await toBuffer(ctx.workbook),
      filename: `${slug}_${period.from}_${period.to}.xlsx`,
    };
  }

  /** Kết quả bán hàng: kỳ này cạnh khoảng cùng độ dài ngay trước đó; dòng Doanh thu thuần, Lợi nhuận gộp in đậm như web. */
  private async resultSheet({
    user,
    workbook,
    period,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const previous = previousBusinessDates(period);
    const [overview, before] = await Promise.all([
      this.stats.getOverview(user, orderQuery),
      this.stats.getOverview(
        user,
        Object.assign(new StatsQueryDto(), {
          fromDate: previous.from,
          toDate: previous.to,
          branchId: orderQuery.branchId,
        }),
      ),
    ]);
    type Overview = typeof overview;
    /** Tỷ suất lợi nhuận gộp trên doanh thu thuần, dạng phân số. */
    const marginOf = (o: Overview) =>
      o.revenue > 0 ? Math.round((o.grossProfit / o.revenue) * 1000) / 1000 : 0;
    const lines: {
      label: string;
      pick: (o: Overview) => number;
      strong?: boolean;
      percent?: boolean;
    }[] = [
      { label: 'Doanh thu bán hàng', pick: (o) => o.grossSales },
      { label: 'Hàng bán bị trả lại', pick: (o) => o.returns },
      { label: 'Thu nhập khác', pick: (o) => o.otherIncome },
      { label: 'Doanh thu thuần', pick: (o) => o.revenue, strong: true },
      { label: 'Giá vốn hàng bán', pick: (o) => o.costOfGoods },
      { label: 'Chi phí vận chuyển thực', pick: (o) => o.shippingCost },
      { label: 'Phí sàn', pick: (o) => o.channelFee },
      { label: 'Lợi nhuận gộp', pick: (o) => o.grossProfit, strong: true },
      { label: 'Tỷ suất lợi nhuận gộp', pick: marginOf, percent: true },
      { label: 'Số đơn hoàn tất', pick: (o) => o.orderCount },
      { label: 'Số đơn có hàng trả', pick: (o) => o.returnCount },
      { label: 'Số khách mua hàng', pick: (o) => o.customerCount },
      { label: 'Giá trị đơn trung bình', pick: (o) => o.aov },
    ];

    const out = new ReportSheet(
      workbook.addWorksheet('Kết quả bán hàng'),
      [36, 26, 26, 18, 14],
    );
    out.title('Kết quả bán hàng', [
      periodLine,
      'Doanh thu, giá vốn và lợi nhuận gộp của kỳ, so với khoảng cùng độ dài ngay trước đó',
    ]);
    out.tableHeader(
      [
        'Chỉ tiêu',
        `Kỳ này (${periodText(period)})`,
        `Kỳ trước (${periodText(previous)})`,
        'Chênh lệch',
        '% thay đổi',
      ],
      [1, 2, 3, 4],
    );
    for (const line of lines) {
      const current = line.pick(overview);
      const prior = line.pick(before);
      // Tỷ suất đã là phần trăm: chênh lệch tính bằng điểm phần trăm, không tính % của %.
      const change =
        line.percent || prior === 0
          ? null
          : (current - prior) / Math.abs(prior);
      out.dataRow([line.label, current, prior, current - prior, change], {
        strong: line.strong,
        percent: line.percent ? [1, 2, 3] : [4],
      });
    }
    out.blank();
    out.note(
      `${REVENUE_NOTE} Doanh thu bán hàng gồm tiền hàng và phí vận chuyển thu của khách; thu nhập khác là tiền giữ lại khi huỷ hoặc trả hàng. Lợi nhuận gộp = doanh thu thuần − giá vốn − chi phí vận chuyển thực − phí sàn.` +
        (overview.linesMissingCost > 0
          ? ` Có ${overview.linesMissingCost} dòng hàng đã bán chưa có giá vốn nên lợi nhuận gộp đang cao hơn thực tế.`
          : ''),
    );
  }

  /** Doanh thu theo ngày / tháng: mọi mốc trong kỳ, kể cả mốc không có đơn (như bảng trên web). */
  private async timeSheet({
    user,
    query,
    workbook,
    period,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const byMonth = query.groupBy === GroupBy.MONTH;
    const series = await this.stats.getRevenueSeries(
      user,
      Object.assign(new RevenueSeriesQueryDto(), orderQuery, {
        groupBy: byMonth ? GroupBy.MONTH : GroupBy.DAY,
      }),
    );
    const byBucket = new Map(
      series.series.map((point) => [
        point.bucket.slice(0, byMonth ? 7 : 10),
        point,
      ]),
    );
    const rows = dateBuckets(period, byMonth ? 'month' : 'day').map(
      (bucket) => {
        const point = byBucket.get(bucket);
        return {
          label: byMonth
            ? `${bucket.slice(5, 7)}/${bucket.slice(0, 4)}`
            : formatDateVi(bucket),
          orderCount: point?.orderCount ?? 0,
          returns: point?.returns ?? 0,
          revenue: point?.revenue ?? 0,
        };
      },
    );
    const orders = sumOf(rows, (r) => r.orderCount);
    const revenue = sumOf(rows, (r) => r.revenue);

    const out = new ReportSheet(
      workbook.addWorksheet('Theo thời gian'),
      [16, 12, 18, 20, 18],
    );
    out.title(byMonth ? 'Doanh thu theo tháng' : 'Doanh thu theo ngày', [
      periodLine,
      'Số đơn hoàn tất, hàng trả và doanh thu thuần của từng mốc trong kỳ',
    ]);
    out.tableHeader(
      [
        byMonth ? 'Tháng' : 'Ngày',
        'Số đơn',
        'Hàng trả',
        'Doanh thu thuần',
        'Giá trị đơn TB',
      ],
      [1, 2, 3, 4],
    );
    for (const row of rows) {
      out.dataRow([
        row.label,
        row.orderCount,
        row.returns,
        row.revenue,
        row.orderCount > 0 ? Math.round(row.revenue / row.orderCount) : null,
      ]);
    }
    out.dataRow(
      [
        'Cộng',
        orders,
        sumOf(rows, (r) => r.returns),
        revenue,
        orders > 0 ? Math.round(revenue / orders) : null,
      ],
      { strong: true },
    );
    out.blank();
    out.note(REVENUE_NOTE);
  }

  private async productSheet({
    user,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const { products } = await this.stats.getTopProducts(
      user,
      Object.assign(new TopProductsQueryDto(), orderQuery, {
        sortBy: TopProductsSort.REVENUE,
        limit: TOP_IN_EXPORT,
      }),
    );
    const revenue = sumOf(products, (p) => p.revenue);

    const out = new ReportSheet(
      workbook.addWorksheet('Theo hàng hóa'),
      [8, 46, 14, 20, 12],
    );
    out.title('Doanh thu theo hàng hóa', [
      periodLine,
      'Số lượng và tiền hàng bán ra của từng mặt hàng trong kỳ, đã trừ hàng trả; xếp theo doanh thu',
    ]);
    out.tableHeader(
      ['STT', 'Hàng hóa', 'Số lượng bán', 'Doanh thu', 'Tỷ trọng'],
      [2, 3, 4],
    );
    products.forEach((p, index) =>
      out.dataRow(
        [
          index + 1,
          p.productName,
          p.quantity,
          p.revenue,
          shareOf(p.revenue, revenue),
        ],
        {
          center: [0],
          percent: [4],
        },
      ),
    );
    if (products.length === 0) out.emptyRow();
    else
      out.dataRow(
        [null, 'Cộng', sumOf(products, (p) => p.quantity), revenue, null],
        { strong: true },
      );
    out.blank();
    out.note(
      'Tối đa 50 mặt hàng có doanh thu cao nhất. Món trong combo có dòng riêng với doanh thu 0 (tiền nằm ở dòng combo).',
    );
  }

  /**
   * Bảng doanh thu theo đối tượng (điểm bán, nhân viên, khách hàng): STT, các cột tên, rồi Số đơn, Doanh thu thuần, Giá trị đơn TB, Tỷ trọng - như `revenueColumns` trên web.
   * Dòng Cộng có số đơn và doanh thu; hai cột còn lại để trống như web.
   */
  private revenueTable(
    out: ReportSheet,
    nameHeaders: string[],
    rows: {
      names: CellValue[];
      orderCount: number;
      revenue: number;
      aov: number;
    }[],
  ) {
    const revenue = sumOf(rows, (r) => r.revenue);
    const first = 1 + nameHeaders.length;
    out.tableHeader(
      [
        'STT',
        ...nameHeaders,
        'Số đơn',
        'Doanh thu thuần',
        'Giá trị đơn TB',
        'Tỷ trọng',
      ],
      [first, first + 1, first + 2, first + 3],
    );
    rows.forEach((row, index) =>
      out.dataRow(
        [
          index + 1,
          ...row.names,
          row.orderCount,
          row.revenue,
          row.aov,
          shareOf(row.revenue, revenue),
        ],
        {
          center: [0],
          percent: [first + 3],
        },
      ),
    );
    if (rows.length === 0) out.emptyRow();
    else
      out.dataRow(
        [
          null,
          'Cộng',
          ...nameHeaders.slice(1).map(() => null),
          sumOf(rows, (r) => r.orderCount),
          revenue,
          null,
          null,
        ],
        { strong: true },
      );
  }

  private async branchSheet({
    user,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const { branches } = await this.stats.getRevenueByBranch(user, orderQuery);
    const out = new ReportSheet(
      workbook.addWorksheet('Theo điểm bán'),
      [8, 36, 12, 20, 18, 12],
    );
    out.title('Doanh thu theo điểm bán', [
      periodLine,
      'Doanh thu thuần của từng chi nhánh trong kỳ',
    ]);
    this.revenueTable(
      out,
      ['Chi nhánh'],
      branches.map((b) => ({ ...b, names: [b.branchName ?? 'Chi nhánh'] })),
    );
    out.blank();
    out.note(REVENUE_NOTE);
  }

  private async staffSheet({
    user,
    query,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const { staff } = await this.stats.getRevenueByStaff(
      user,
      Object.assign(new RevenueByStaffQueryDto(), orderQuery, {
        groupBy: query.staffGroupBy,
      }),
    );
    const out = new ReportSheet(
      workbook.addWorksheet('Theo nhân viên'),
      [8, 36, 12, 20, 18, 12],
    );
    out.title('Doanh thu theo nhân viên', [
      periodLine,
      STAFF_DESCRIPTION[query.staffGroupBy] ?? STAFF_DESCRIPTION.assignee,
    ]);
    this.revenueTable(
      out,
      ['Nhân viên'],
      staff.map((s) => ({
        ...s,
        names: [s.staffName ?? 'Không gắn nhân viên'],
      })),
    );
  }

  private async customerSheet({
    user,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const { customers } = await this.stats.getTopCustomers(
      user,
      Object.assign(new TopCustomersQueryDto(), orderQuery, {
        limit: TOP_IN_EXPORT,
      }),
    );
    const out = new ReportSheet(
      workbook.addWorksheet('Khách hàng'),
      [8, 32, 16, 12, 20, 18, 12],
    );
    out.title('Doanh thu theo khách hàng', [
      periodLine,
      'Khách mua nhiều nhất trong kỳ, xếp theo doanh thu thuần; không gồm khách vãng lai',
    ]);
    this.revenueTable(
      out,
      ['Khách hàng', 'Số điện thoại'],
      customers.map((c) => ({
        ...c,
        names: [c.name ?? 'Không rõ', c.phone ?? '-'],
      })),
    );
    out.blank();
    out.note(
      'Tối đa 50 khách có doanh thu cao nhất; tỷ trọng tính trên tổng của các khách trong bảng.',
    );
  }

  private async ordersSheet({
    user,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const { statuses, totalCount } = await this.stats.getOrdersByStatus(
      user,
      orderQuery,
    );
    const out = new ReportSheet(
      workbook.addWorksheet('Trạng thái đơn'),
      [30, 12, 12, 20],
    );
    out.title('Đơn hàng theo trạng thái', [
      periodLine,
      'Mọi đơn tạo trong kỳ, gồm cả đơn huỷ và trả hàng',
    ]);
    out.tableHeader(
      ['Trạng thái', 'Số đơn', 'Tỷ lệ', 'Giá trị đơn'],
      [1, 2, 3],
    );
    for (const s of statuses)
      out.dataRow(
        [
          orderStatusLabel(s.status),
          s.count,
          shareOf(s.count, totalCount),
          s.total,
        ],
        { percent: [2] },
      );
    if (statuses.length === 0) out.emptyRow();
    else
      out.dataRow(['Cộng', totalCount, null, sumOf(statuses, (s) => s.total)], {
        strong: true,
      });
    out.blank();
    out.note(
      'Giá trị đơn là tổng tiền của đơn theo trạng thái hiện tại, không phải doanh thu đã ghi nhận.',
    );
  }

  /** Tab Thu chi: hai bảng như trên trang, mỗi bảng một sheet. */
  private async cashSheets({
    user,
    query,
    workbook,
    periodLine,
    orderQuery,
  }: ReportContext) {
    const dates = { fromDate: query.fromDate, toDate: query.toDate };
    const [byMethod, cashflow] = await Promise.all([
      this.stats.getRevenueByPaymentMethod(user, orderQuery),
      this.stats.getCashflow(
        user,
        Object.assign(
          new CashflowQueryDto(),
          query.warehouseId
            ? { ...dates, warehouseId: query.warehouseId }
            : { ...dates, branchId: query.branchId, flow: 'ORD' },
        ),
      ),
    ]);

    const methods = byMethod.breakdown;
    const pay = new ReportSheet(
      workbook.addWorksheet('Phương thức thanh toán'),
      [26, 12, 18, 18, 18, 18],
    );
    pay.title('Tiền thực thu theo phương thức thanh toán', [
      periodLine,
      'Tiền khách trả trong kỳ theo từng phương thức, đã trừ hoàn tiền và tiền thối',
    ]);
    pay.tableHeader(
      ['Phương thức', 'Số đơn', 'Đã thu', 'Đã hoàn', 'Tiền thối', 'Thực thu'],
      [1, 2, 3, 4, 5],
    );
    for (const m of methods)
      pay.dataRow([
        paymentMethodLabel(m.paymentMethod) || 'Chưa xác định',
        m.orderCount,
        m.received,
        m.refunded,
        m.change,
        m.revenue,
      ]);
    if (methods.length === 0) pay.emptyRow();
    else
      pay.dataRow(
        [
          'Cộng',
          null,
          sumOf(methods, (m) => m.received),
          sumOf(methods, (m) => m.refunded),
          sumOf(methods, (m) => m.change),
          sumOf(methods, (m) => m.revenue),
        ],
        { strong: true },
      );
    pay.blank();
    pay.note(
      'Tính theo ngày thu tiền nên có thể khác doanh thu thuần của cùng kỳ (doanh thu ghi theo ngày đơn hoàn thành).',
    );

    const cash = new ReportSheet(
      workbook.addWorksheet('Thu chi'),
      [18, 30, 14, 18, 18],
    );
    cash.title('Thu chi theo quỹ', [
      periodLine,
      query.warehouseId
        ? 'Tiền vào và tiền ra tại kho trong kỳ, theo quỹ và khoản mục'
        : 'Thu chi bán hàng trong kỳ, theo quỹ và khoản mục',
    ]);
    cash.tableHeader(
      ['Quỹ', 'Khoản mục', 'Số giao dịch', 'Thu', 'Chi'],
      [2, 3, 4],
    );
    for (const row of cashflow.byCategory)
      cash.dataRow([
        fundLabel(row.fund),
        cashFlowCategoryLabel(row.category),
        row.count,
        row.flowType === 'INCOME' ? row.total : null,
        row.flowType === 'EXPENSE' ? row.total : null,
      ]);
    if (cashflow.byCategory.length === 0) cash.emptyRow();
    else
      cash.dataRow(['Cộng', null, null, cashflow.income, cashflow.expense], {
        strong: true,
      });
    cash.dataRow(['Chênh lệch thu chi', null, null, cashflow.net, null], {
      strong: true,
    });
    for (const fund of cashflow.byFund)
      cash.dataRow([`- ${fundLabel(fund.fund)}`, null, null, fund.net, null]);
  }

  /** Tab Tồn kho: tổng quan và hàng sắp hết, mỗi bảng một sheet; số tại thời điểm xuất, không theo kỳ. */
  private async inventorySheets({
    user,
    query,
    workbook,
    placeName,
  }: ReportContext) {
    const inventory = await this.stats.getInventory(
      user,
      Object.assign(new InventoryStatsQueryDto(), {
        branchId: query.branchId,
        warehouseId: query.warehouseId,
        lowStockThreshold: query.lowStockThreshold,
      }),
    );
    const locationIds = [
      ...new Set(
        inventory.lowStock
          .map((i) => i.branchId ?? i.warehouseId)
          .filter((id): id is string => !!id),
      ),
    ];
    const locations = await this.prisma.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(locations.map((l) => [l.id, l.name]));
    const asOf = `Tại ngày ${formatDateVi(vietnamDateOf(new Date()))} - ${placeName}`;

    const summary = new ReportSheet(workbook.addWorksheet('Tồn kho'), [44, 22]);
    summary.title('Tổng quan tồn kho', [
      asOf,
      'Mức tồn tại thời điểm xem, không theo kỳ báo cáo',
    ]);
    summary.tableHeader(['Chỉ tiêu', 'Giá trị'], [1]);
    summary.dataRow([
      'Giá trị hàng tồn kho (theo giá vốn)',
      inventory.stockValue,
    ]);
    summary.dataRow(['Tổng số lượng tồn', inventory.totalUnits]);
    summary.dataRow(['Số mặt hàng (SKU) đang có tồn', inventory.skuCount]);
    summary.dataRow(['Số mặt hàng hết hàng', inventory.outOfStock]);

    const low = new ReportSheet(
      workbook.addWorksheet('Hàng sắp hết'),
      [8, 40, 18, 24, 14],
    );
    low.title('Hàng sắp hết', [
      asOf,
      `Mặt hàng có tồn từ ${inventory.lowStockThreshold} trở xuống`,
    ]);
    low.tableHeader(
      ['STT', 'Hàng hóa', 'Mã hàng', 'Vị trí', 'Số lượng tồn'],
      [4],
    );
    inventory.lowStock.forEach((item, index) =>
      low.dataRow(
        [
          index + 1,
          item.productName,
          item.sku,
          nameOf.get(item.branchId ?? item.warehouseId ?? '') ??
            (item.locationType === 'WAREHOUSE' ? 'Kho' : 'Chi nhánh'),
          item.stock,
        ],
        { center: [0] },
      ),
    );
    if (inventory.lowStock.length === 0)
      low.emptyRow('Không có mặt hàng sắp hết');
  }
}
