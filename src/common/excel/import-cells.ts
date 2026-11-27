import type * as ExcelJS from 'exceljs';

// Đọc ô và chữ của file Excel nhập liệu, dùng chung cho nhập hàng hoá và nhập đơn hàng.

export type CellValue = string | number | boolean | Date | null | undefined;

/** Tên → id, đã chuẩn hoá. Một tên trỏ về nhiều id là tên trùng: không chọn bừa. */
export type NameIndex = Map<string, string[]>;

export const YES = 'Có';
export const NO = 'Không';

/** So tên không phân biệt hoa/thường và cách gõ dấu (NFC), bỏ khoảng trắng thừa. */
export function normalizeName(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi');
}

export function buildNameIndex(
  entries: { id: string; names: string[] }[],
): NameIndex {
  const index: NameIndex = new Map();
  for (const { id, names } of entries) {
    for (const name of new Set(names.map(normalizeName))) {
      if (!name) continue;
      const ids = index.get(name) ?? [];
      if (!ids.includes(id)) ids.push(id);
      index.set(name, ids);
    }
  }
  return index;
}

/** Nội dung ô dưới dạng chữ đã trim; số giữ nguyên chữ số (không có dấu phân cách). */
export function textOf(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? YES : NO;
  return value.normalize('NFC').trim();
}

/** Đọc số tiền / phần trăm từ ô Excel theo cách viết ở Việt Nam. */
export function numberOf(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = textOf(value)
    .replace(/[đ₫%]|vnđ|vnd/gi, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(text)) {
    text = text.replace(/[.,]/g, '');
  } else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(text)) {
    text = text.replace(/,/g, '');
  } else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else {
    text = text.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

export function hasMoreThanTwoDecimals(n: number): boolean {
  return Math.abs(Math.round(n * 100) - n * 100) > 1e-6;
}

/** Chuẩn hoá tiêu đề cột để so khớp. */
export function headerKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\(\s*\*\s*\)/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi');
}

/** Giá trị thật của một ô exceljs: công thức lấy kết quả, chữ định dạng / hyperlink lấy chữ. */
export function cellValue(cell: ExcelJS.Cell): CellValue {
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
