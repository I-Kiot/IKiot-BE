import { randomBytes } from 'node:crypto';

// Một bộ sinh cho mọi mã tham chiếu, tiền tố lấy từ REFERENCE_PREFIX. 5 byte ngẫu nhiên giữ va chạm không đáng kể so với unique index toàn cục, nên đừng giảm byteLength nếu không có lý do.
export function generateReference(prefix: string, byteLength = 5): string {
  return prefix + randomBytes(byteLength).toString('hex').toUpperCase();
}

/** Regex neo đầu để tìm/lọc tham chiếu của một luồng, ví dụ referenceMatcher('ORD') -> /^ORD/i. */
export function referenceMatcher(prefix: string): RegExp {
  return new RegExp('^' + prefix, 'i');
}

// Giá trị được LƯU trên các dòng lịch sử - không bao giờ đổi tiền tố đã có, chỉ được thêm.
export const REFERENCE_PREFIX = {
  ORDER: 'ORD',
  SUPPLIER: 'SUP',
  SUBSCRIPTION: 'IKMS', // tenant trả tiền iKiot cho gói (tài khoản công ty, không phải CashFlow của tenant)
  TICKET: 'TK', // ticket hỗ trợ; hiển thị cho cả shop lẫn người vận hành
  PACKAGE: 'PK', // FulfillmentPackage.code - in trên nhãn thùng
  ORDER_RETURN: 'DH-HOAN-',
} as const;

export const CASHFLOW_PREFIXES = [
  REFERENCE_PREFIX.ORDER,
  REFERENCE_PREFIX.SUPPLIER,
];
