import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { normalizePhone } from '../../common/utils/phone';
import { EsmsService } from './esms.service';
import { ErrorCode } from '../../common/errors/error-codes';

const OTP_TTL_SECONDS = 5 * 60;

interface OtpEntry {
  code: string;
  expiresAt: number;
}

/** OTP lưu trong Redis, key theo `normalizePhone` nên mã yêu cầu bằng `0912345678` vẫn xác minh được với `+84912345678`. Có fallback bộ nhớ như service cũ cho dev local (chỉ một process). */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly fallback = new Map<string, OtpEntry>();

  constructor(
    private readonly esms: EsmsService,
    private readonly redis: RedisService,
  ) {}

  private keyFor(phone: string): string {
    return `otp:register:${normalizePhone(phone)}`;
  }

  private generateCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** Chỉ ở dev: code rỗng hoặc sentinel token bỏ qua xác minh (DEV_OTP_BYPASS_TOKEN của hệ thống cũ). Tắt hẳn ở production. */
  private isDevBypass(code: string): boolean {
    if (process.env.NODE_ENV === 'production') return false;
    const sentinel = process.env.DEV_OTP_BYPASS_TOKEN || 'DEV_BYPASS';
    return !code || code === sentinel;
  }

  private async store(phone: string, code: string): Promise<void> {
    const key = this.keyFor(phone);
    if (await this.redis.set(key, code, OTP_TTL_SECONDS)) return;
    this.fallback.set(key, {
      code,
      expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
    });
  }

  private async read(phone: string): Promise<string | null> {
    const key = this.keyFor(phone);
    const fromRedis = await this.redis.get(key);
    if (fromRedis !== null) return fromRedis;

    const entry = this.fallback.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.fallback.delete(key);
      return null;
    }
    return entry.code;
  }

  private async clear(phone: string): Promise<void> {
    const key = this.keyFor(phone);
    await this.redis.del(key);
    this.fallback.delete(key);
  }

  /** Tạo, lưu và gửi OTP (dev chưa cấu hình eSMS thì chỉ log ra console). Lỗi cổng SMS trả 503 có tên dịch vụ SMS, vì eSMS từ chối vì lỗi phía ta sửa được: hết số dư, brandname bị khoá, sai key. */
  async sendOtp(phoneNumber: string): Promise<{ sent: true }> {
    if (!phoneNumber)
      throw new BadRequestException({
        code: ErrorCode.PHONE_REQUIRED,
        message: 'Phone number is required',
      });

    const code = this.generateCode();
    await this.store(phoneNumber, code);

    if (this.esms.isConfigured()) {
      try {
        await this.esms.sendOtpSms(phoneNumber, code);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.error(`eSMS refused to send an OTP: ${detail}`);
        throw new ServiceUnavailableException({
          code: ErrorCode.OTP_SEND_FAILED,
          message:
            'Could not send the OTP by SMS. Please try again in a few minutes.',
        });
      }
    } else if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`📱 [DEV OTP] ${normalizePhone(phoneNumber)} -> ${code}`);
    } else {
      throw new BadRequestException({
        code: ErrorCode.SMS_NOT_CONFIGURED,
        message: 'SMS service is not configured',
      });
    }

    return { sent: true };
  }

  async verifyOtp(phoneNumber: string, code: string): Promise<true> {
    if (this.isDevBypass(code)) return true;

    const stored = await this.read(phoneNumber);
    if (stored === null) {
      throw new BadRequestException({
        code: ErrorCode.OTP_EXPIRED,
        message:
          'OTP has expired or was not requested. Please request a new code.',
      });
    }
    if (String(code).trim() !== stored) {
      throw new BadRequestException({
        code: ErrorCode.OTP_INVALID,
        message: 'Invalid OTP code',
      });
    }

    await this.clear(phoneNumber);
    return true;
  }
}
