import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { ErrorCode } from './common/errors/error-codes';

export function pendingMigrations(
  shipped: readonly string[],
  applied: readonly string[],
): string[] {
  const done = new Set(applied);
  return shipped.filter((name) => !done.has(name));
}

/** Tên thư mục migration đi kèm image (`prisma/migrations/<timestamp>_<name>`). Trả null khi thiếu thư mục: build đó không tự kiểm tra được. */
function shippedMigrations(): string[] | null {
  try {
    return readdirSync(join(process.cwd(), 'prisma', 'migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

@Injectable()
export class AppService {
  /** Đọc một lần: thư mục nằm trong image và không đổi khi đang chạy. */
  private readonly shipped = shippedMigrations();

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process còn sống. Cố ý không đụng tới DB để sự cố DB không làm container trông như đã chết. */
  health() {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * Readiness: DB trả lời và có đủ migration của build này. `/health` từng báo ok khi code mới chạy trên schema cũ, nên CI chờ check này. 503 kèm tên migration còn thiếu.
   */
  async ready() {
    let applied: string[];
    try {
      const rows = await this.prisma.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      applied = rows.map((row) => row.migration_name);
    } catch {
      throw new ServiceUnavailableException({
        code: ErrorCode.SERVICE_NOT_READY,
        message: 'The database is not reachable, or has never been migrated',
      });
    }
    const pending = this.shipped
      ? pendingMigrations(this.shipped, applied)
      : [];
    if (pending.length > 0) {
      throw new ServiceUnavailableException({
        code: ErrorCode.SERVICE_NOT_READY,
        message: `${pending.length} migration(s) not applied: ${pending.join(', ')}`,
      });
    }
    return {
      status: 'ready',
      migrations: applied.length,
      checked: this.shipped !== null,
    };
  }
}
