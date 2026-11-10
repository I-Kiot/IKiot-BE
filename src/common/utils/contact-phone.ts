/** Từ 8 đến 15 chữ số: 8 là số bàn không mã vùng hoặc đường dây nóng (1900xxxx), 15 là mức dài nhất của E.164. */
const CONTACT_PHONE_REGEX = /^\+?\d{8,15}$/;

/**
 * SĐT liên hệ (khách, chi nhánh, kho) có dạng hợp lý không. Khác `validateVietnamPhoneNumber` của tài khoản nhân viên, luật này cố ý rộng: số liên hệ có thể là số bàn hoặc có mã nước, từ chối chúng sẽ chặn đơn và chi nhánh hợp lệ; chỉ chặn thứ hiển nhiên không phải số như `123` hay `abc`.
 * Bỏ khoảng trắng, dấu chấm, gạch và ngoặc trước khi đếm; dấu `+` chỉ được đứng đầu.
 */
export function isContactPhone(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const compact = value.trim().replace(/[\s\-().]/g, '');
  return CONTACT_PHONE_REGEX.test(compact);
}
