import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { EmailService } from '../../common/email/email.service';
import { ErrorCode } from '../../common/errors/error-codes';

export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export const OtpPurpose = {
  VERIFY_EMAIL: 'verify-email',
  RESET_PASSWORD: 'reset-password',
} as const;
export type OtpPurpose = (typeof OtpPurpose)[keyof typeof OtpPurpose];

/** Thông tin trả cho client sau khi gửi mã. */
export interface OtpDelivery {
  sentTo: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

interface OtpEntry {
  hash: string;
  challengeId: string;
  attempts: number;
  expiresAt: number;
  sentAt: number;
}

/** Che email: `nguyen@gmail.com` → `ng***@gmail.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const keep = Math.min(2, Math.max(0, local.length - 1));
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

/** OTP qua email, lưu hash trong Redis: có hạn, dùng một lần, giới hạn số lần thử, cooldown gửi lại. */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly fallback = new Map<string, OtpEntry>();
  private readonly burned = new Map<string, number>();

  constructor(
    private readonly email: EmailService,
    private readonly redis: RedisService,
  ) {}

  private keyFor(purpose: OtpPurpose, userId: string): string {
    return `otp:${purpose}:${userId}`;
  }

  private hashCode(key: string, code: string): string {
    return createHash('sha256').update(`${key}:${code}`).digest('hex');
  }

  private generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** Chỉ ở dev: sentinel token bỏ qua xác minh. Mã rỗng KHÔNG còn được bỏ qua. Tắt hẳn ở production. */
  private isDevBypass(code: string): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    const sentinel = process.env.DEV_OTP_BYPASS_TOKEN || 'DEV_BYPASS';
    return code === sentinel;
  }

  private async read(key: string): Promise<OtpEntry | null> {
    const raw = await this.redis.get(key);
    if (raw !== null) {
      try {
        return JSON.parse(raw) as OtpEntry;
      } catch {
        return null;
      }
    }
    return this.fallback.get(key) ?? null;
  }

  private async write(key: string, entry: OtpEntry): Promise<void> {
    const ttl = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    if (await this.redis.set(key, JSON.stringify(entry), ttl)) {
      this.fallback.delete(key);
      return;
    }
    this.fallback.set(key, entry);
  }

  private async clear(key: string): Promise<void> {
    await this.redis.del(key);
    this.fallback.delete(key);
  }

  private delivery(email: string): OtpDelivery {
    return {
      sentTo: maskEmail(email),
      expiresInSeconds: OTP_TTL_SECONDS,
      resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    };
  }

  /** Tạo, lưu hash và gửi mã; trong cooldown thì từ chối hoặc gắn sang challenge mới. */
  async send(
    purpose: OtpPurpose,
    user: { id: string; email: string },
    challengeId: string,
    onCooldown: 'reject' | 'rebind' = 'reject',
  ): Promise<OtpDelivery> {
    const key = this.keyFor(purpose, user.id);
    const now = Date.now();
    const existing = await this.read(key);

    if (
      existing &&
      existing.expiresAt > now &&
      now - existing.sentAt < OTP_RESEND_COOLDOWN_SECONDS * 1000
    ) {
      if (onCooldown === 'reject') {
        const retryAfterSeconds = Math.ceil(
          (OTP_RESEND_COOLDOWN_SECONDS * 1000 - (now - existing.sentAt)) / 1000,
        );
        throw new HttpException(
          {
            code: ErrorCode.OTP_RESEND_TOO_SOON,
            message: 'Please wait before requesting another code',
            retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await this.write(key, { ...existing, challengeId });
      return this.delivery(user.email);
    }

    const code = this.generateCode();
    await this.write(key, {
      hash: this.hashCode(key, code),
      challengeId,
      attempts: 0,
      expiresAt: now + OTP_TTL_SECONDS * 1000,
      sentAt: now,
    });

    if (!this.email.isConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        await this.clear(key);
        throw new ServiceUnavailableException({
          code: ErrorCode.EMAIL_NOT_CONFIGURED,
          message: 'Email service is not configured',
        });
      }
      this.logger.log(`📧 [DEV OTP] ${purpose} ${user.email} -> ${code}`);
      return this.delivery(user.email);
    }

    try {
      await this.email.sendOtpEmail(user.email, code, {
        purpose,
        ttlMinutes: OTP_TTL_SECONDS / 60,
      });
    } catch (error) {
      // Xoá entry để cooldown không chặn lần thử lại.
      await this.clear(key);
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not send an OTP email: ${detail}`);
      throw new ServiceUnavailableException({
        code: ErrorCode.OTP_SEND_FAILED,
        message:
          'Could not send the OTP by email. Please try again in a few minutes.',
      });
    }
    return this.delivery(user.email);
  }

  async verify(
    purpose: OtpPurpose,
    userId: string,
    challengeId: string,
    code: string,
  ): Promise<true> {
    const key = this.keyFor(purpose, userId);
    const submitted = String(code ?? '').trim();

    if (this.isDevBypass(submitted)) {
      await this.clear(key);
      return true;
    }

    const entry = await this.read(key);
    if (!entry || entry.challengeId !== challengeId) {
      throw this.expired();
    }
    // Store có thể còn trả entry đã quá hạn (đồng hồ lệch, TTL chưa quét): kiểm tra lại ở đây.
    if (entry.expiresAt <= Date.now()) {
      await this.clear(key);
      throw this.expired();
    }

    const expected = Buffer.from(entry.hash, 'hex');
    const actual = Buffer.from(this.hashCode(key, submitted), 'hex');
    if (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    ) {
      await this.clear(key);
      return true;
    }

    const attempts = entry.attempts + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await this.clear(key);
      throw new BadRequestException({
        code: ErrorCode.OTP_TOO_MANY_ATTEMPTS,
        message: 'Too many incorrect attempts. Please request a new code.',
      });
    }
    await this.write(key, { ...entry, attempts });
    throw new BadRequestException({
      code: ErrorCode.OTP_INVALID,
      message: 'Invalid OTP code',
      attemptsLeft: OTP_MAX_ATTEMPTS - attempts,
    });
  }

  /** Dấu dùng một lần. `false` = đã dùng rồi. */
  async burn(id: string, ttlSeconds: number): Promise<boolean> {
    const key = `otp:used:${id}`;
    const created = await this.redis.setIfAbsent(key, '1', ttlSeconds);
    if (created !== null) return created;

    const now = Date.now();
    for (const [k, exp] of this.burned) if (exp <= now) this.burned.delete(k);
    if (this.burned.has(key)) return false;
    this.burned.set(key, now + ttlSeconds * 1000);
    return true;
  }

  private expired(): BadRequestException {
    return new BadRequestException({
      code: ErrorCode.OTP_EXPIRED,
      message:
        'OTP has expired or was not requested. Please request a new code.',
    });
  }
}
