import { Logger } from '@nestjs/common';

/** What the server needs before accepting traffic - fail at boot, not on the first request that needs the value. */
const REQUIRED = [['DATABASE_URL', 'Postgres connection string']] as const;

/** Access-token key: ACCESS_TOKEN_SECRET then JWT_SECRET (iKiotMS-BE's precedence), resolved once so signer and verifier cannot disagree. */
export function accessTokenSecret(): string {
  return (
    process.env.ACCESS_TOKEN_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    ''
  );
}

/** Refresh tokens may have their own key; they fall back to the access one, as before. */
export function refreshTokenSecret(): string {
  return process.env.REFRESH_TOKEN_SECRET?.trim() || accessTokenSecret();
}

/** Vars the app runs without: each is logged at boot naming the feature it disables. */
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
] as const;

/** Browser origins allowed over HTTP and Socket.IO: comma-separated `CORS_ORIGIN`, else `FRONTEND_URL`, else `true` (dev only). */
export function corsOrigins(): string[] | true {
  const configured =
    process.env.CORS_ORIGIN?.trim() || process.env.FRONTEND_URL?.trim();
  if (!configured) return true;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Socket.IO wants `*` rather than `true` for "any origin"; otherwise identical. */
export function socketCorsOrigins(): string[] | string {
  const origins = corsOrigins();
  return origins === true ? '*' : origins;
}

/** Called from bootstrap() before Nest is created: throws on a missing required var, and in production refuses an open CORS policy. */
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

  // Asks the same resolver the app uses - a check that disagreed with it is worse than no check.
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
