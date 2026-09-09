import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { HolidaySyncService } from './holiday-sync.service';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';

/** Ported from holidaySyncJob.js: 02:30 on the first of each month, current year and next (December must already know about January), skipped without GOOGLE_CALENDAR_API_KEY, and one tenant's failure never stops the sweep. */
@Injectable()
export class HolidayCronService {
  private readonly logger = new Logger(HolidayCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: HolidaySyncService,
  ) {}

  @Cron('30 2 1 * *', { timeZone: VIETNAM_TIMEZONE })
  async runMonthlySync(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (!process.env.GOOGLE_CALENDAR_API_KEY) {
      this.logger.log('Skipped: GOOGLE_CALENDAR_API_KEY is not set');
      return;
    }

    const tenants = await this.prisma.tenant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });
    const currentYear = new Date().getFullYear();

    for (const tenant of tenants) {
      for (const year of [currentYear, currentYear + 1]) {
        try {
          await this.sync.syncVietnamPublicHolidays(tenant.id, year);
        } catch (error) {
          this.logger.error(
            `Holiday sync failed for tenant ${tenant.id} (${year})`,
            error instanceof Error ? error.stack : error,
          );
        }
      }
    }
  }
}
