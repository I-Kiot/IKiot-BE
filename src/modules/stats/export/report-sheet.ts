import * as ExcelJS from 'exceljs';

/**
 * Khung trình bày chung cho mọi file báo cáo xuất ra: cách dàn trang của sổ kế toán Việt Nam (Phụ lục III Thông tư 99/2025/TT-BTC):
 * góc trái tên đơn vị + địa chỉ, góc phải số hiệu mẫu, tên sổ in hoa ở giữa, bảng kẻ ô có dòng ký hiệu cột, cuối trang là ngày tháng và ba ô chữ ký.
 * Báo cáo không có mẫu quy định (đối soát tiền, báo cáo quản trị) dùng cùng khung, chỉ bỏ ô "Mẫu số".
 */

export const REPORT_FONT = 'Times New Roman';
const MONEY_FORMAT = '#,##0;-#,##0';

/** Căn cứ pháp lý in dưới số hiệu mẫu, nguyên văn theo Thông tư. */
export const TT99_LEGAL_NOTE =
  '(Kèm theo Thông tư số 99/2025/TT-BTC ngày 27 tháng 10 năm 2025 của Bộ trưởng Bộ Tài chính)';

export interface ReportUnit {
  name: string;
  address: string | null;
  taxNumber: string | null;
}

/** Một cột của bảng: cột đơn, hoặc nhóm gộp có các cột con. */
export interface ColumnGroup {
  label: string;
  children?: string[];
}

export type CellValue = string | number | null;

const THIN: ExcelJS.Border = { style: 'thin', color: { argb: 'FF000000' } };
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

/** "Ngày 14 tháng 11 năm 2026", dòng ngày trên ô chữ ký. */
export function longDateVi(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-');
  return `Ngày ${d} tháng ${m} năm ${y}`;
}

/** Con trỏ dòng của một sheet: mỗi hàm viết xong thì đẩy `row` xuống. */
export class ReportSheet {
  row = 1;
  readonly columnCount: number;

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
      margins: {
        left: 0.4,
        right: 0.4,
        top: 0.5,
        bottom: 0.5,
        header: 0.2,
        footer: 0.2,
      },
    };
    sheet.headerFooter.oddFooter = '&C&"Times New Roman"&10Trang &P / &N';
  }

  private text(
    row: number,
    fromCol: number,
    toCol: number,
    value: string,
    style: {
      bold?: boolean;
      italic?: boolean;
      size?: number;
      align?: 'left' | 'center' | 'right';
      wrap?: boolean;
    } = {},
  ): void {
    if (toCol > fromCol) this.sheet.mergeCells(row, fromCol, row, toCol);
    const cell = this.sheet.getCell(row, fromCol);
    cell.value = value;
    cell.font = {
      name: REPORT_FONT,
      size: style.size ?? 11,
      bold: style.bold,
      italic: style.italic,
    };
    cell.alignment = {
      horizontal: style.align ?? 'left',
      vertical: 'middle',
      wrapText: style.wrap,
    };
  }

  /** Đầu trang: đơn vị + địa chỉ bên trái; số hiệu mẫu + căn cứ bên phải (nếu là sổ theo mẫu). */
  unitHeader(unit: ReportUnit, form?: { code: string; legalNote: string }) {
    const split = Math.max(2, Math.ceil(this.columnCount / 2));
    this.text(this.row, 1, split, `Đơn vị: ${unit.name}`, { bold: true });
    this.text(
      this.row + 1,
      1,
      split,
      `Địa chỉ: ${unit.address ?? '....................'}`,
    );
    if (form) {
      this.text(this.row, split + 1, this.columnCount, `Mẫu số ${form.code}`, {
        bold: true,
        align: 'center',
      });
      this.text(this.row + 1, split + 1, this.columnCount, form.legalNote, {
        italic: true,
        size: 10,
        align: 'center',
        wrap: true,
      });
      this.sheet.getRow(this.row + 1).height = 30;
    } else if (unit.taxNumber) {
      this.text(this.row + 2, 1, split, `Mã số thuế: ${unit.taxNumber}`);
      this.row += 1;
    }
    this.row += 3;
  }

  /** Tên sổ in hoa ở giữa, các dòng phụ đề bên dưới. */
  title(title: string, subtitles: string[] = []) {
    this.text(this.row, 1, this.columnCount, title, {
      bold: true,
      size: 14,
      align: 'center',
    });
    this.sheet.getRow(this.row).height = 22;
    this.row += 1;
    for (const line of subtitles) {
      this.text(this.row, 1, this.columnCount, line, {
        italic: true,
        align: 'center',
      });
      this.row += 1;
    }
    this.row += 1;
  }

  /** Tiêu đề mục trong báo cáo nhiều bảng. */
  heading(label: string) {
    this.text(this.row, 1, this.columnCount, label, { bold: true, size: 12 });
    this.row += 1;
  }

  /** Dòng ghi chú thường (không kẻ ô). */
  note(label: string, italic = true) {
    this.text(this.row, 1, this.columnCount, label, { italic, wrap: true });
    this.row += 1;
  }

  blank(rows = 1) {
    this.row += rows;
  }

  /** Đầu bảng: nhóm gộp chiếm hai dòng (tên nhóm trên, cột con dưới), cột đơn gộp dọc. `symbols` là dòng ký hiệu cột (A, B, C, 1, 2...). */
  tableHeader(columns: ColumnGroup[], symbols?: string[], repeat = true) {
    const twoRows = columns.some((c) => c.children?.length);
    const top = this.row;
    let col = 1;
    for (const column of columns) {
      const span = column.children?.length ?? 1;
      if (column.children?.length) {
        this.sheet.mergeCells(top, col, top, col + span - 1);
        this.headerCell(top, col, column.label);
        column.children.forEach((child, i) =>
          this.headerCell(top + 1, col + i, child),
        );
        for (let i = 1; i < span; i++) this.borderOnly(top, col + i);
      } else {
        if (twoRows) {
          this.sheet.mergeCells(top, col, top + 1, col);
          this.borderOnly(top + 1, col);
        }
        this.headerCell(top, col, column.label);
      }
      col += span;
    }
    this.row += twoRows ? 2 : 1;
    if (symbols) {
      symbols.forEach((symbol, i) => this.headerCell(this.row, i + 1, symbol));
      this.row += 1;
    }
    // Đầu bảng lặp lại trên mỗi trang in; sheet nhiều bảng thì không (chỉ lặp được một đầu bảng).
    if (repeat) this.sheet.pageSetup.printTitlesRow = `${top}:${this.row - 1}`;
  }

  private headerCell(row: number, col: number, value: string) {
    const cell = this.sheet.getCell(row, col);
    cell.value = value;
    cell.font = { name: REPORT_FONT, size: 11, bold: true };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'middle',
      wrapText: true,
    };
    cell.border = BORDER;
  }

  private borderOnly(row: number, col: number) {
    this.sheet.getCell(row, col).border = BORDER;
  }

  /** Một dòng số liệu kẻ ô. Số căn phải, định dạng nghìn; chữ căn trái. `null` là ô trống. */
  dataRow(
    values: CellValue[],
    style: { bold?: boolean; italic?: boolean; center?: number[] } = {},
  ) {
    for (let i = 0; i < this.columnCount; i++) {
      const value = values[i] ?? null;
      const cell = this.sheet.getCell(this.row, i + 1);
      cell.value = value;
      cell.font = {
        name: REPORT_FONT,
        size: 11,
        bold: style.bold,
        italic: style.italic,
      };
      cell.border = BORDER;
      if (typeof value === 'number') {
        cell.numFmt = MONEY_FORMAT;
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

  /** Dòng cho biết bảng không có số liệu, gộp ngang cả bảng. */
  emptyRow(label = 'Không có số liệu trong kỳ') {
    this.sheet.mergeCells(this.row, 1, this.row, this.columnCount);
    for (let col = 1; col <= this.columnCount; col++)
      this.borderOnly(this.row, col);
    const cell = this.sheet.getCell(this.row, 1);
    cell.value = label;
    cell.font = { name: REPORT_FONT, size: 11, italic: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    this.row += 1;
  }

  /** Cuối sổ: ngày tháng phía trên ô chữ ký cuối, rồi các chức danh và "(Ký, họ tên)". */
  signatures(dateLine: string, signers: { title: string; hint: string }[]) {
    this.row += 1;
    const width = Math.floor(this.columnCount / signers.length);
    const rangeOf = (index: number): [number, number] => {
      const from = index * width + 1;
      const to =
        index === signers.length - 1 ? this.columnCount : from + width - 1;
      return [from, to];
    };
    const [lastFrom, lastTo] = rangeOf(signers.length - 1);
    this.text(this.row, lastFrom, lastTo, dateLine, {
      italic: true,
      align: 'center',
    });
    this.row += 1;
    signers.forEach((signer, index) => {
      const [from, to] = rangeOf(index);
      this.text(this.row, from, to, signer.title, {
        bold: true,
        align: 'center',
      });
      this.text(this.row + 1, from, to, signer.hint, {
        italic: true,
        align: 'center',
      });
    });
    this.row += 6;
  }
}

/** Ba chữ ký của sổ kế toán theo Thông tư 99/2025. */
export const LEDGER_SIGNERS = [
  { title: 'Người ghi sổ', hint: '(Ký, họ tên)' },
  { title: 'Kế toán trưởng', hint: '(Ký, họ tên)' },
  { title: 'Người đại diện theo pháp luật', hint: '(Ký, họ tên, đóng dấu)' },
];

/** Chữ ký của báo cáo quản trị (không có mẫu quy định). */
export const REPORT_SIGNERS = [
  { title: 'Người lập biểu', hint: '(Ký, họ tên)' },
  { title: 'Kế toán trưởng', hint: '(Ký, họ tên)' },
  { title: 'Người đại diện theo pháp luật', hint: '(Ký, họ tên, đóng dấu)' },
];

export function newWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iKiot';
  workbook.created = new Date();
  return workbook;
}

export async function toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
