import { createHmac } from 'node:crypto';

/** Id giả cho challenge mồi: HMAC của email có dạng UUID v4 như id thật và cố định theo email, để mồi chịu đúng cooldown như tài khoản thật. */
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
