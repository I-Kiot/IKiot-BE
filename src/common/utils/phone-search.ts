/** Chuỗi tìm kiếm có giống số điện thoại không. */
const PHONE_LIKE = /^[\d\s\-.()+]+$/;

/** Ít hơn ngần này chữ số thì quá chung (`09` khớp gần hết khách), nên coi là tìm chữ thường. */
const MIN_PHONE_DIGITS = 3;

/** Các dạng chữ số để tìm theo SĐT khách, rỗng nếu chuỗi không giống số điện thoại. */
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
