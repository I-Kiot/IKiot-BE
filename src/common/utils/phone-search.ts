/** Chỉ gồm chữ số, dấu `+`, khoảng trắng, chấm, gạch và ngoặc: người gõ đang tìm một số điện thoại chứ không phải tên hay mã. */
const PHONE_LIKE = /^[\d\s\-.()+]+$/;

/** Ít hơn ngần này chữ số thì quá chung (`09` khớp gần hết khách), nên coi là tìm chữ thường. */
const MIN_PHONE_DIGITS = 3;

/**
 * Các chuỗi chữ số để dò trên cột SĐT khách. `Customer.phone` được lưu chỉ còn chữ số, nên `091 234 5678`, `091.234.5678` hay `+84912345678` gõ nguyên văn sẽ không khớp `0912345678` dù là cùng một số.
 * Trả mảng rỗng nếu chuỗi tìm không giống số điện thoại (khi đó chỉ tìm theo tên, mã như cũ). `0912...` và `84912...` là hai cách viết của cùng một số nên đều được thử.
 */
export function phoneSearchTerms(search: string): string[] {
  const raw = search.trim();
  if (!PHONE_LIKE.test(raw)) return [];
  const digits = raw.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return [];

  const terms = new Set([digits]);
  if (digits.startsWith('84') && digits.length > 4) {
    terms.add(`0${digits.slice(2)}`);
  }
  if (digits.startsWith('0') && digits.length > 3) {
    terms.add(`84${digits.slice(1)}`);
  }
  return [...terms];
}
