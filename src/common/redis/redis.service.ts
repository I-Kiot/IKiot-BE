import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

/** Kết nối Redis duy nhất. Redis chết không bao giờ là lỗi chí mạng: caller rẽ nhánh theo `isReady()`, còn mọi method trả về như thể key không tồn tại. */
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
        // `rediss://` là scheme TLS; spread thay vì `tls: boolean` vì options của socket là union phân biệt theo trường này.
        ...(url.startsWith('rediss://') ? { tls: true as const } : {}),
        connectTimeout: 10_000,
        // Thử ba lần rồi bỏ: caller tự suy giảm chức năng, còn vòng retry vô hạn sẽ chôn log thật.
        reconnectStrategy: (retries) =>
          retries > 3 ? false : Math.min(retries * 500, 3000),
      },
      pingInterval: 4 * 60 * 1000,
    });

    // Chỉ log một lần cho mỗi đợt mất kết nối, không log mỗi lần retry - nếu không vòng reconnect sẽ làm ngập log.
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

  // Đồng bộ có chủ đích: `quit()` chờ phản hồi và làm treo shutdown khi kết nối đã mất.
  onModuleDestroy(): void {
    if (!this.client) return;
    try {
      this.client.destroy();
    } catch {
      // Đã đóng rồi.
    }
    this.client = null;
  }

  /** Redis có thực sự dùng được lúc này không. Caller rẽ nhánh theo cái này. */
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

  /** `ttlSeconds` bắt buộc - không thứ gì app đưa vào Redis được phép sống mãi. */
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
      // Không cần làm gì - key sẽ tự hết hạn.
    }
  }

  /** Mọi key dưới một prefix, qua SCAN thay vì KEYS - KEYS khoá server, mà hàm này chạy khi người dùng đang dùng app. */
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
