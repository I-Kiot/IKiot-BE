import { createHmac } from 'node:crypto';

/**
 * "Quên mật khẩu" không được cho biết một email có tài khoản hay không (PO, 2026-11-26).
 * Email không có tài khoản hợp lệ (không tồn tại, bị khoá, đã xoá) nhận một challenge "mồi":
 * `sub` của nó là id giả sinh từ email bằng HMAC, nên:
 * - nó có dạng UUID v4 như id người dùng thật (`sub` của JWT đọc được ở client);
 * - cùng một email luôn ra cùng một id, như người dùng thật, nên gửi lại nhiều lần
 *   rơi vào đúng cooldown / ràng buộc mã cũ như tài khoản thật;
 * - không đoán được id của email khác khi không có khoá.
 * Không bao giờ có người dùng nào mang id này, nên mọi bước sau đều nhận ra nó là mồi
 * bằng việc tra người dùng không thấy.
 */
export function decoySubjectId(email: string, secret: string): string {
  const h = createHmac('sha256', secret)
    .update(`forgot-password-decoy:${email}`)
    .digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}
