import * as ExcelJS from 'exceljs';

/**
 * Khung chung của mọi file báo cáo xuất ra: bảng thống kê giống hệt bảng trên trang web (chốt 2026-11-23, bỏ khung sổ TT99).
 * Mỗi bảng: tên báo cáo + dòng kỳ/địa điểm, đầu bảng tô nền và cố định khi cuộn, các dòng số liệu, dòng tổng in đậm.
 * Không có đầu trang đơn vị, số hiệu mẫu, dòng ký hiệu cột hay ô chữ ký.
 */

export const REPORT_FONT = 'Arial';
const MONEY_FORMAT = '#,##0;-#,##0';
const PERCENT_FORMAT = '0.0%';
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFE7E6E6' },
};
/** Nền của dòng tổng / dòng in đậm giữa bảng, như `bg-muted` trên web. */
const STRONG_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF2F2F2' },
};

export type CellValue = string | number | null;

const THIN: ExcelJS.Border = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER: Partial<ExcelJS.Borders> = {
  top: THIN,
  left: THIN,
  bottom: THIN,
  right: THIN,
};

/** `2026-11-14` -> `14/11/2026`. */
export function formatDateVi(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Tỷ trọng dạng phân số cho ô định dạng %, tổng không dương thì để trống (web hiện "-"). */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Con trỏ dòng của một sheet: mỗi hàm viết xong thì đẩy `row` xuống. */
export class ReportSheet {
  row = 1;
  readonly columnCount: number;
  private frozen = false;

  constructor(
    readonly sheet: ExcelJS.Worksheet,
    widths: number[],
  ) {
    this.columnCount = widths.length;
    sheet.columns = widths.map((width) => ({ width }));
    sheet.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }

  private text(
    row: number,
    value: string,
    style: { bold?: boolean; italic?: boolean; size?: number } = {},
  ): void {
    if (this.columnCount > 1)
      this.sheet.mergeCells(row, 1, row, this.columnCount);
    const cell = this.sheet.getCell(row, 1);
    cell.value = value;
    cell.font = {
      name: REPORT_FONT,
      size: style.size ?? 10,
      bold: style.bold,
      italic: style.italic,
    };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
  }

  /** Tên báo cáo (như tiêu đề thẻ trên web) và các dòng phụ (kỳ, địa điểm). */
  title(title: string, subtitles: string[] = []) {
    this.text(this.row, title, { bold: true, size: 14 });
    this.sheet.getRow(this.row).height = 22;
    this.row += 1;
    for (const line of subtitles) {
      this.text(this.row, line, { italic: true });
      this.row += 1;
    }
    this.row += 1;
  }

  /** Tiêu đề bảng con khi một sheet có nhiều bảng. */
  heading(label: string) {
    this.text(this.row, label, { bold: true, size: 12 });
    this.row += 1;
  }

  /** Ghi chú dưới bảng (như dòng chú thích nhỏ trên web). */
  note(label: string) {
    this.text(this.row, label, { italic: true, size: 9 });
    this.sheet.getCell(this.row, 1).alignment = {
      horizontal: 'left',
      vertical: 'top',
      wrapText: true,
    };
    this.row += 1;
  }

  blank(rows = 1) {
    this.row += rows;
  }

  /** Đầu bảng: một dòng tên cột, tô nền. Bảng đầu tiên của sheet được cố định đầu bảng khi cuộn và lặp khi in. */
  tableHeader(headers: string[], numeric: number[] = []) {
    headers.forEach((header, i) => {
      const cell = this.sheet.getCell(this.row, i + 1);
      cell.value = header;
      cell.font = { name: REPORT_FONT, size: 10, bold: true };
      cell.fill = HEADER_FILL;
      cell.border = BORDER;
      cell.alignment = {
        horizontal: numeric.includes(i) ? 'right' : 'left',
        vertical: 'middle',
        wrapText: true,
      };
    });
    if (!this.frozen) {
      this.sheet.views = [{ state: 'frozen', ySplit: this.row }];
      this.sheet.pageSetup.printTitlesRow = `${this.row}:${this.row}`;
      this.frozen = true;
    }
    this.row += 1;
  }

  /**
   * Một dòng số liệu. Số căn phải, định dạng nghìn; `percent` là chỉ số các cột tỷ lệ (giá trị là phân số, in dạng 12,3%).
   * `strong` là dòng tổng / dòng in đậm giữa bảng. `null` là ô trống.
   */
  dataRow(
    values: CellValue[],
    style: { strong?: boolean; percent?: number[]; center?: number[] } = {},
  ) {
    for (let i = 0; i < values.length; i++) {
      const value = values[i] ?? null;
      const cell = this.sheet.getCell(this.row, i + 1);
      cell.value = value;
      cell.font = { name: REPORT_FONT, size: 10, bold: style.strong };
      cell.border = BORDER;
      if (style.strong) cell.fill = STRONG_FILL;
      if (typeof value === 'number') {
        cell.numFmt = style.percent?.includes(i)
          ? PERCENT_FORMAT
          : MONEY_FORMAT;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
      } else {
        cell.alignment = {
          horizontal: style.center?.includes(i) ? 'center' : 'left',
          vertical: 'middle',
          wrapText: true,
        };
      }
    }
    this.row += 1;
  }

  /** Bảng không có dòng nào: một ô gộp ngang, cùng câu chữ với web. */
  emptyRow(label = 'Không có số liệu trong kỳ', columns = this.columnCount) {
    if (columns > 1) this.sheet.mergeCells(this.row, 1, this.row, columns);
    for (let col = 1; col <= columns; col++)
      this.sheet.getCell(this.row, col).border = BORDER;
    const cell = this.sheet.getCell(this.row, 1);
    cell.value = label;
    cell.font = { name: REPORT_FONT, size: 10, italic: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    this.row += 1;
  }
}

export function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iKiot';
  workbook.created = new Date();
  return workbook;
}

export async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
