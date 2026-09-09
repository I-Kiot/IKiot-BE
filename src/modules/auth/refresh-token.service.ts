import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { RealtimeGateway } from '../../common/realtime/realtime.gateway';
import { refreshTokenSecret } from '../../common/config/env';
import { ErrorCode } from '../../common/errors/error-codes';

/** Seven days, the window iKiotMS-BE's RefreshToken documents carried. */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

interface RefreshPayload {
  sub: string;
  /** Which stored session this token is; the id is the Redis key's tail. */
  jti: string;
  type: 'refresh';
}

interface StoredSession {
  userId: string;
  userAgent: string | null;
  issuedAt: number;
}

/** Refresh tokens in Redis, keeping every behaviour of iKiotMS-BE's Mongo collection: a key per token (`refresh:<userId>:<jti>`), Redis expiry for the TTL index, deletion instead of `isRevoked`, and a SCAN for "log this user out everywhere". If Redis is down every key reads as missing, so refresh fails and the user re-authenticates - a cache outage must not hand out sessions it cannot revoke. */
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

  /** Mints a refresh token and records the session it stands for. */
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
      // Handing back a token we cannot revoke is worse than none: the access token still works, so the caller is logged in, just not refreshable.
      this.logger.warn(
        'Refresh token was not stored (Redis unavailable) - session will not be refreshable',
      );
    }
    return token;
  }

  /** Rotates a refresh token - verifies it, revokes the one presented, issues a new pair - so a second use of a long-lived bearer credential is a plain failure. */
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

  /** Logout. Silently does nothing for a token that is already gone or unparseable. */
  async revoke(userId: string, token: string): Promise<void> {
    let payload: RefreshPayload;
    try {
      payload = this.verify(token);
    } catch {
      return;
    }
    // Only the owner may revoke it, and the controller takes `userId` from the access token rather than the body.
    if (payload.sub !== userId) return;
    await this.redis.del(this.key(userId, payload.jti));
  }

  /** Ends every session a user has, on both transports. Deleting the Redis keys covers HTTP; the Socket.IO disconnect is folded in here because it is the leg every caller forgot, leaving a deactivated account still streaming the shop's live feed. */
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
    // Refresh and access tokens are signed by different secrets only when REFRESH_TOKEN_SECRET is set, so this check is what stops an access token being replayed as a refresh one.
    if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_INVALID,
        message: 'Invalid refresh token',
      });
    }
    return payload;
  }

  /** Carries the original user agent across a rotation, as the old code did. */
  private userAgentOf(stored: string): string | undefined {
    try {
      return (JSON.parse(stored) as StoredSession).userAgent ?? undefined;
    } catch {
      return undefined;
    }
  }
}
