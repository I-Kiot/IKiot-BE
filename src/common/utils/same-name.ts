/** Khoá so sánh tên: bỏ khoảng trắng hai đầu, chuẩn hoá Unicode, đổi chữ thường. So trong code thay vì `mode: 'insensitive'` của Prisma vì Postgres không đổi hoa/thường chữ có dấu khi DB dùng collation `C` ("Bàn" và "bÀN" lọt qua). */
export function nameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/** Hai tên có cùng một danh tính không (không phân biệt hoa thường, khoảng trắng đầu cuối). */
export function isSameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}
