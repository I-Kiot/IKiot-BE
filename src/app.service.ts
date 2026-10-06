import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { ErrorCode } from './common/errors/error-codes';

/** The migrations this build was made with but the database has not finished. */
export function pendingMigrations(
  shipped: readonly string[],
  applied: readonly string[],
): string[] {
  const done = new Set(applied);
  return shipped.filter((name) => !done.has(name));
}

/** Migration folder names shipped with this build (`prisma/migrations/<timestamp>_<name>`), or null when the folder is not there (a build without it cannot tell). */
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
  /** Read once: the folder is part of the image and does not change while it runs. */
  private readonly shipped = shippedMigrations();

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up. Deliberately touches nothing else, so a database blip does not make the container look dead. */
  health() {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * Readiness: the database answers and holds every migration this build ships. A deploy that put
   * new code on an old schema answered `/health` with "ok" while every query failed (2026-10-07,
   * dev) - this is the check CI waits on instead. 503 with the pending names when not ready.
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
