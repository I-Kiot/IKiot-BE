/** Khoá so sánh tên: bỏ khoảng trắng, chuẩn hoá Unicode, chữ thường. */
export function nameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/** Hai tên có cùng một danh tính không (không phân biệt hoa thường, khoảng trắng đầu cuối). */
export function isSameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}
