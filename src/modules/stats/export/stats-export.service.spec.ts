import * as ExcelJS from 'exceljs';
import { StatsExportService } from './stats-export.service';
import { SalesJournalExportQueryDto } from '../dto/stats-query.dto';
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

  // Một đơn bán 2 ghế (2.000.000, giá vốn 1.200.000) có phí ship 50.000, rồi trả lại 1 ghế, và một khoản tiền giữ lại 100.000.
  const journal = [
    {
      entryType: 'SALE',
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
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Nội thất A',
          mainAddress: 'Hà Nội',
          taxNumber: null,
        }),
      },
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

  it('đặt tên file theo kỳ và có đủ hai mẫu sổ', async () => {
    const { file, workbook } = await exportSheets();
    expect(file.filename).toBe('so-doanh-thu_2026-11-01_2026-11-30.xlsx');
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'S03a4-DN',
      'S35-DN',
    ]);
  });

  it('S03a4-DN: mỗi bút toán một dòng, dòng cộng khớp tổng các cột', async () => {
    const { workbook } = await exportSheets();
    const rows = cellsOf(workbook.getWorksheet('S03a4-DN')!);
    expect(rowWith(rows, 'Mẫu số S03a4-DN')).toBeDefined();
    expect(rowWith(rows, 'SỔ NHẬT KÝ BÁN HÀNG')).toBeDefined();
    expect(rowWith(rows, 'Bán hàng - Chị Lan').slice(4)).toEqual([
      2_050_000,
      2_000_000,
      null,
      50_000,
      0,
    ]);
    // Phải thu = hàng hoá + dịch vụ + thu nhập khác, hàng trả ghi âm.
    expect(rowWith(rows, 'Cộng số phát sinh').slice(4)).toEqual([
      1_150_000,
      1_000_000,
      null,
      50_000,
      100_000,
    ]);
  });

  it('S35-DN: hàng trả ghi ở cột các khoản tính trừ, cuối sổ ra doanh thu thuần, giá vốn và lãi gộp', async () => {
    const { workbook } = await exportSheets();
    const rows = cellsOf(workbook.getWorksheet('S35-DN')!);
    // Số lượng, đơn giá, thành tiền, thuế, khoản tính trừ.
    expect(rowWith(rows, 'Ghế gỗ (GHE-01)').slice(5)).toEqual([
      2,
      1_000_000,
      2_000_000,
      null,
      null,
    ]);
    expect(
      rowWith(rows, 'Hàng bán bị trả lại: Ghế gỗ (GHE-01)').slice(5),
    ).toEqual([1, 1_000_000, null, null, 1_000_000]);
    expect(rowWith(rows, 'Cộng số phát sinh').slice(7)).toEqual([
      2_000_000,
      null,
      1_000_000,
    ]);
    expect(rowWith(rows, '- Doanh thu thuần')[7]).toBe(1_000_000);
    expect(rowWith(rows, '- Giá vốn hàng bán')[7]).toBe(600_000);
    expect(rowWith(rows, '- Lãi gộp')[7]).toBe(400_000);
  });
});
