import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

/** The one Redis connection. Redis being down is never fatal: `isReady()` is what callers branch on, and every method answers as though the key simply wasn't there. */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType | null = null;
  private loggedError = false;

  async onModuleInit(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) {
      this.logger.warn(
        'REDIS_URL is not set - refresh tokens and OTP codes fall back to in-memory storage',
      );
      return;
    }

    const client: RedisClientType = createClient({
      url,
      socket: {
        // `rediss://` is the TLS scheme; spread rather than `tls: boolean` because the socket options are a discriminated union on that field.
        ...(url.startsWith('rediss://') ? { tls: true as const } : {}),
        connectTimeout: 10_000,
        // Give up after three tries: the callers degrade gracefully, and an endless retry loop buries the real logs.
        reconnectStrategy: (retries) =>
          retries > 3 ? false : Math.min(retries * 500, 3000),
      },
      pingInterval: 4 * 60 * 1000,
    });

    // Logged once per outage, not once per retry - a reconnect loop otherwise floods the log.
    client.on('error', (error: Error) => {
      if (this.loggedError) return;
      this.loggedError = true;
      this.logger.warn(`Redis unavailable: ${error.message}`);
    });
    client.on('ready', () => {
      this.loggedError = false;
      this.logger.log('Redis connected');
    });

    this.client = client;
    try {
      await client.connect();
    } catch (error) {
      this.logger.warn(
        `Redis connection failed, continuing without it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Synchronous on purpose: `quit()` awaits a reply and hangs shutdown when the connection is already gone.
  onModuleDestroy(): void {
    if (!this.client) return;
    try {
      this.client.destroy();
    } catch {
      // already closed
    }
    this.client = null;
  }

  /** Whether Redis is actually usable right now. Callers branch on this. */
  isReady(): boolean {
    return this.client?.isReady ?? false;
  }

  async get(key: string): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      return await this.client!.get(key);
    } catch {
      return null;
    }
  }

  /** `ttlSeconds` is required - nothing this app puts in Redis is allowed to live forever. */
  async set(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.isReady()) return false;
    try {
      await this.client!.set(key, value, { EX: ttlSeconds });
      return true;
    } catch {
      return false;
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.isReady() || keys.length === 0) return;
    try {
      await this.client!.del(keys);
    } catch {
      // nothing to do - the key stays until it expires on its own
    }
  }

  /** Every key under a prefix, via SCAN rather than KEYS - KEYS blocks the server, and this runs while people are using the app. */
  async keysMatching(pattern: string): Promise<string[]> {
    if (!this.isReady()) return [];
    try {
      const found: string[] = [];
      for await (const key of this.client!.scanIterator({
        MATCH: pattern,
        COUNT: 200,
      })) {
        if (Array.isArray(key)) found.push(...key);
        else found.push(key);
      }
      return found;
    } catch {
      return [];
    }
  }
}
