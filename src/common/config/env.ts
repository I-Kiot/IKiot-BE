import { Logger } from '@nestjs/common';

/** Những gì server cần trước khi nhận traffic - lỗi ngay lúc boot, không đợi tới request đầu tiên cần giá trị. */
const REQUIRED = [['DATABASE_URL', 'Postgres connection string']] as const;

/** Khoá access token: ACCESS_TOKEN_SECRET rồi tới JWT_SECRET (thứ tự ưu tiên của iKiotMS-BE). Resolve một lần để signer và verifier không lệch nhau. */
export function accessTokenSecret(): string {
  return (
    process.env.ACCESS_TOKEN_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    ''
  );
}

/** Refresh token có thể có khoá riêng; không có thì dùng khoá access như trước. */
export function refreshTokenSecret(): string {
  return process.env.REFRESH_TOKEN_SECRET?.trim() || accessTokenSecret();
}

/** Biến tuỳ chọn: app vẫn chạy khi thiếu; mỗi biến thiếu được log lúc boot kèm tính năng bị tắt. */
const OPTIONAL = [
  [
    'REDIS_URL',
    'refresh tokens and OTP codes fall back to in-memory / no sessions',
  ],
  ['CLOUDINARY_CLOUD_NAME', 'file uploads are disabled'],
  ['MAIL_HOST', 'subscription reminders and announcements are not sent'],
  ['GEMINI_API_KEY', 'the AI assistant answers 503'],
  ['GOOGLE_CALENDAR_API_KEY', 'the holiday sync cron is skipped'],
  ['FIREBASE_PRIVATE_KEY', 'Firebase login and FCM push are disabled'],
  [
    'SEPAY_WEBHOOK_API_KEY',
    'the subscription payment webhook rejects everything',
  ],
  [
    'SEPAY_ORDER_WEBHOOK_API_KEY',
    'the shared order webhook is off - only shops with their own webhook key can take QR payments',
  ],
  ['SEPAY_API_KEY', 'shops are never marked as linked to SePay automatically'],
] as const;

/** Origin trình duyệt được phép gọi qua HTTP và Socket.IO: `CORS_ORIGIN` (phân cách bằng dấu phẩy), không có thì `FRONTEND_URL`, không có nữa thì `true` (chỉ dev). */
export function corsOrigins(): string[] | true {
  const configured =
    process.env.CORS_ORIGIN?.trim() || process.env.FRONTEND_URL?.trim();
  if (!configured) return true;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Socket.IO cần `*` thay vì `true` để nghĩa là "mọi origin"; còn lại giống nhau. */
export function socketCorsOrigins(): string[] | string {
  const origins = corsOrigins();
  return origins === true ? '*' : origins;
}

/** Gọi từ bootstrap() trước khi tạo Nest: throw nếu thiếu biến bắt buộc; ở production từ chối CORS mở. */
export function validateEnv(logger = new Logger('Env')): void {
  const missing = REQUIRED.filter(([key]) => !process.env[key]?.trim());
  if (missing.length > 0) {
    const detail = missing.map(([key, why]) => `  ${key} - ${why}`).join('\n');
    throw new Error(`Missing required environment variables:\n${detail}`);
  }

  if (!accessTokenSecret()) {
    throw new Error(
      'Set ACCESS_TOKEN_SECRET (or JWT_SECRET) - without it every issued token is signed with an empty key.',
    );
  }

  // Hỏi đúng bộ resolve mà app dùng - kiểm tra lệch với nó còn tệ hơn không kiểm tra.
  if (process.env.NODE_ENV === 'production' && corsOrigins() === true) {
    throw new Error(
      'CORS_ORIGIN (or FRONTEND_URL) must be set in production - with both unset any origin may make credentialed requests.',
    );
  }

  for (const [key, consequence] of OPTIONAL) {
    if (!process.env[key]?.trim()) {
      logger.warn(`${key} is not set - ${consequence}.`);
    }
  }
}
