import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { refreshTokenSecret } from '../../common/config/env';
import { ErrorCode } from '../../common/errors/error-codes';

/** Bảy ngày, khớp thời hạn RefreshToken của iKiotMS-BE. */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

interface RefreshPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

interface StoredSession {
  userId: string;
  userAgent: string | null;
  issuedAt: number;
}

/** Refresh token lưu trong Redis, mỗi token một key `refresh:<userId>:<jti>`; xoá key để thu hồi, SCAN để đăng xuất mọi nơi. Redis lỗi thì coi như không có key, refresh thất bại: không cấp phiên mà không thu hồi được. */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private key(userId: string, jti: string): string {
    return `refresh:${userId}:${jti}`;
  }

  private secret(): string {
    return refreshTokenSecret();
  }

  async issue(userId: string, userAgent?: string): Promise<string> {
    const jti = randomUUID();
    const token = this.jwt.sign(
      { sub: userId, jti, type: 'refresh' } satisfies RefreshPayload,
      { secret: this.secret(), expiresIn: REFRESH_TOKEN_TTL_SECONDS },
    );

    const session: StoredSession = {
      userId,
      userAgent: userAgent ?? null,
      issuedAt: Date.now(),
    };
    const stored = await this.redis.set(
      this.key(userId, jti),
      JSON.stringify(session),
      REFRESH_TOKEN_TTL_SECONDS,
    );
    if (!stored) {
      // Trả token không thu hồi được còn tệ hơn không trả: access token vẫn dùng được nên user vẫn đăng nhập, chỉ không refresh được.
      this.logger.warn(
        'Refresh token was not stored (Redis unavailable) - session will not be refreshable',
      );
    }
    return token;
  }

  /** Xoay vòng refresh token: kiểm tra, thu hồi token đã gửi, cấp cặp mới. Dùng lại token này sẽ thất bại. */
  async rotate(
    token: string,
    userAgent?: string,
  ): Promise<{ userId: string; refreshToken: string }> {
    const payload = this.verify(token);

    const stored = await this.redis.get(this.key(payload.sub, payload.jti));
    if (!stored) {
      throw new UnauthorizedException({
        code: ErrorCode.SESSION_EXPIRED,
        message:
          'Your session has expired or was revoked, please sign in again',
      });
    }

    await this.redis.del(this.key(payload.sub, payload.jti));
    const refreshToken = await this.issue(
      payload.sub,
      userAgent ?? this.userAgentOf(stored),
    );
    return { userId: payload.sub, refreshToken };
  }

  /** Không làm gì nếu token đã mất hoặc không parse được. */
  async revoke(userId: string, token: string): Promise<void> {
    let payload: RefreshPayload;
    try {
      payload = this.verify(token);
    } catch {
      return;
    }
    // Chỉ chủ token mới được thu hồi; controller lấy userId từ access token, không từ body.
    if (payload.sub !== userId) return;
    await this.redis.del(this.key(userId, payload.jti));
  }

  /** Kết thúc mọi phiên của user trên cả HTTP và Socket.IO. Socket.IO được ngắt ngay đây vì caller nào cũng quên, khiến tài khoản đã khoá vẫn nhận live feed của shop. */
  async revokeAllFor(userId: string): Promise<void> {
    const keys = await this.redis.keysMatching(`refresh:${userId}:*`);
    await this.redis.del(...keys);
    this.realtime.disconnectUser(userId);
  }

  private verify(token: string): RefreshPayload {
    let payload: RefreshPayload;
    try {
      payload = this.jwt.verify<RefreshPayload>(token, {
        secret: this.secret(),
      });
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Invalid refresh token',
      });
    }
    // Access và refresh token chỉ khác secret khi có REFRESH_TOKEN_SECRET, nên check này chặn việc dùng access token làm refresh token.
    if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Invalid refresh token',
      });
    }
    return payload;
  }

  /** Giữ user agent gốc qua lần xoay vòng (như code cũ). */
  private userAgentOf(stored: string): string | undefined {
    try {
      return (JSON.parse(stored) as StoredSession).userAgent ?? undefined;
    } catch {
      return undefined;
    }
  }
}
