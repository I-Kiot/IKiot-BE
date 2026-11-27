/** Số liên hệ có từ 8 đến 15 chữ số. */
const CONTACT_PHONE_REGEX = /^\+?\d{8,15}$/;

/** Kiểm SĐT liên hệ có dạng hợp lý (cho phép số bàn, mã nước). */
export function isContactPhone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const compact = value.trim().replace(/[\s\-().]/g, '');
  return CONTACT_PHONE_REGEX.test(compact);
}
