import * as ExcelJS from 'exceljs';
import { StatsExportService } from './stats-export.service';
import {
  ReportExportQueryDto,
  SalesJournalExportQueryDto,
} from '../dto/stats-query.dto';
import { SystemRole } from '../../../common/constants/system-role';
import type { AuthUser } from '../../../common/types/auth-user.type';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { StatsService } from '../stats.service';
import type { StatsReportsService } from '../stats-reports.service';

/** Mọi ô của một sheet thành bảng chuỗi / số, bỏ ô phụ của vùng gộp. */
function cellsOf(sheet: ExcelJS.Worksheet): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values: (string | number | null)[] = [];
    for (let col = 1; col <= sheet.columnCount; col++) {
      const cell = row.getCell(col);
      const value = cell.isMerged && cell.master !== cell ? null : cell.value;
      values.push(
        typeof value === 'number' || typeof value === 'string' ? value : null,
      );
    }
    rows.push(values);
  });
  return rows;
}

const rowWith = (rows: (string | number | null)[][], label: string) => {
  const row = rows.find((cells) => cells.includes(label));
  if (!row) throw new Error(`Không thấy dòng "${label}"`);
  return row;
};

describe('StatsExportService.salesJournal', () => {
  const user = {
    userId: 'u1',
    tenantId: 't1',
    systemRole: SystemRole.TENANT_OWNER,
  } as AuthUser;

  // Dữ liệu mẫu: bán 2 ghế, trả 1, giữ lại 100.000.
  const journal = [
    {
      entryType: 'SALE',
      source: 'POS_SALE',
      branchName: 'CN 1',
      orderCode: 'ORD001',
      customerName: 'Chị Lan',
      businessDate: '2026-11-01',
      postedDate: '2026-11-01',
      goodsAmount: 2_000_000,
      shippingAmount: 50_000,
      otherIncomeAmount: 0,
      totalAmount: 2_050_000,
      cogsAmount: 1_200_000,
      lines: [
        {
          productName: 'Ghế gỗ',
          sku: 'GHE-01',
          quantity: 2,
          amount: 2_000_000,
          cogs: 1_200_000,
        },
      ],
    },
    {
      entryType: 'RETURN',
      source: 'POS_RETURN',
      branchName: 'CN 1',
      orderCode: 'ORD001',
      customerName: 'Chị Lan',
      businessDate: '2026-11-03',
      postedDate: '2026-11-03',
      goodsAmount: -1_000_000,
      shippingAmount: 0,
      otherIncomeAmount: 0,
      totalAmount: -1_000_000,
      cogsAmount: -600_000,
      lines: [
        {
          productName: 'Ghế gỗ',
          sku: 'GHE-01',
          quantity: -1,
          amount: -1_000_000,
          cogs: -600_000,
        },
      ],
    },
    {
      entryType: 'OTHER_INCOME',
      source: 'ORDER_CANCEL',
      branchName: 'CN 1',
      orderCode: 'ORD002',
      customerName: null,
      businessDate: '2026-11-04',
      postedDate: '2026-11-04',
      goodsAmount: 0,
      shippingAmount: 0,
      otherIncomeAmount: 100_000,
      totalAmount: 100_000,
      cogsAmount: 0,
      lines: [],
    },
  ];

  async function exportSheets() {
    const prisma = {
      location: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    const reports = {
      getSalesJournalForExport: jest.fn().mockResolvedValue(journal),
    } as unknown as StatsReportsService;
    const service = new StatsExportService(prisma, {} as StatsService, reports);
    const query = Object.assign(new SalesJournalExportQueryDto(), {
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
    });
    const file = await service.salesJournal(user, query);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    return { file, workbook };
  }

  it('đặt tên file theo kỳ; sheet bút toán và sheet dòng hàng, không còn mẫu sổ TT99', async () => {
    const { file, workbook } = await exportSheets();
    expect(file.filename).toBe('so-doanh-thu_2026-11-01_2026-11-30.xlsx');
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'Sổ doanh thu',
      'Dòng hàng',
    ]);
    const all = workbook.worksheets.flatMap((sheet) => cellsOf(sheet).flat());
    expect(all).not.toContain('Mẫu số S03a4-DN');
    expect(all.some((v) => typeof v === 'string' && v.includes('Ký'))).toBe(
      false,
    );
  });

  it('sheet bút toán: cùng cột với bảng trên trang, dòng Tổng cộng khớp tổng các cột', async () => {
    const { workbook } = await exportSheets();
    const rows = cellsOf(workbook.getWorksheet('Sổ doanh thu')!);
    expect(rowWith(rows, 'Ngày')).toEqual([
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
    ]);
    expect(rowWith(rows, 'Bán hàng')).toEqual([
      '01/11/2026',
      'Bán hàng',
      'ORD001',
      'CN 1',
      'Bán tại quầy',
      2_000_000,
      50_000,
      0,
      2_050_000,
      1_200_000,
    ]);
    expect(rowWith(rows, 'Tổng cộng').slice(5)).toEqual([
      1_000_000, 50_000, 100_000, 1_150_000, 600_000,
    ]);
  });

  it('sheet dòng hàng: mỗi dòng hàng một dòng, hàng trả giữ số âm', async () => {
    const { workbook } = await exportSheets();
    const rows = cellsOf(workbook.getWorksheet('Dòng hàng')!);
    const ghe = rows.filter((cells) => cells.includes('Ghế gỗ'));
    expect(ghe.map((cells) => cells.slice(4))).toEqual([
      [2, 2_000_000, 1_200_000],
      [-1, -1_000_000, -600_000],
    ]);
    expect(rowWith(rows, 'Tổng cộng').slice(4)).toEqual([
      1, 1_000_000, 600_000,
    ]);
  });
});

describe('StatsExportService.report', () => {
  const user = {
    userId: 'u1',
    tenantId: 't1',
    systemRole: SystemRole.TENANT_OWNER,
  } as AuthUser;

  async function exportReport(params: Partial<ReportExportQueryDto>) {
    const prisma = {
      location: { findFirst: jest.fn(), findMany: jest.fn() },
    } as unknown as PrismaService;
    const overview = {
      grossSales: 1_000,
      returns: -100,
      otherIncome: 0,
      revenue: 900,
      costOfGoods: 500,
      shippingCost: 0,
      channelFee: 0,
      grossProfit: 400,
      orderCount: 3,
      returnCount: 1,
      customerCount: 2,
      aov: 300,
      linesMissingCost: 0,
    };
    const stats = {
      getRevenueByStaff: jest.fn().mockResolvedValue({
        groupBy: 'assignee',
        staff: [
          {
            userId: 'a',
            staffName: 'An',
            revenue: 300,
            orderCount: 1,
            aov: 300,
          },
          {
            userId: null,
            staffName: null,
            revenue: 100,
            orderCount: 1,
            aov: 100,
          },
        ],
      }),
      getOverview: jest
        .fn()
        .mockResolvedValueOnce(overview)
        .mockResolvedValueOnce({ ...overview, revenue: 450, grossProfit: 200 }),
    } as unknown as StatsService;
    const service = new StatsExportService(
      prisma,
      stats,
      {} as StatsReportsService,
    );
    const query = Object.assign(new ReportExportQueryDto(), {
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      ...params,
    });
    const file = await service.report(user, query);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as unknown as ExcelJS.Buffer);
    return { file, workbook };
  }

  it('xuất riêng báo cáo nhân viên: cột như web, dòng Cộng, tỷ trọng dạng phân số', async () => {
    const { file, workbook } = await exportReport({ section: 'staff' });
    expect(file.filename).toBe(
      'doanh-thu-theo-nhan-vien_2026-11-01_2026-11-30.xlsx',
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Theo nhân viên']);
    const sheet = workbook.getWorksheet('Theo nhân viên')!;
    const rows = cellsOf(sheet);
    expect(rowWith(rows, 'STT').slice(0, 6)).toEqual([
      'STT',
      'Nhân viên',
      'Số đơn',
      'Doanh thu thuần',
      'Giá trị đơn TB',
      'Tỷ trọng',
    ]);
    expect(rowWith(rows, 'An').slice(0, 6)).toEqual([
      1,
      'An',
      1,
      300,
      300,
      0.75,
    ]);
    expect(rowWith(rows, 'Không gắn nhân viên')[5]).toBe(0.25);
    expect(rowWith(rows, 'Cộng').slice(0, 6)).toEqual([
      null,
      'Cộng',
      2,
      400,
      null,
      null,
    ]);
    // Đầu bảng cố định khi cuộn.
    expect(sheet.views[0]).toMatchObject({ state: 'frozen' });
  });

  it('kết quả bán hàng: so với kỳ trước, % thay đổi là phân số', async () => {
    const { workbook } = await exportReport({ section: 'result' });
    const rows = cellsOf(workbook.getWorksheet('Kết quả bán hàng')!);
    expect(rowWith(rows, 'Chỉ tiêu')[1]).toBe(
      'Kỳ này (01/11/2026 – 30/11/2026)',
    );
    expect(rowWith(rows, 'Chỉ tiêu')[2]).toBe(
      'Kỳ trước (02/10/2026 – 31/10/2026)',
    );
    expect(rowWith(rows, 'Doanh thu thuần').slice(1)).toEqual([
      900, 450, 450, 1,
    ]);
  });
});
