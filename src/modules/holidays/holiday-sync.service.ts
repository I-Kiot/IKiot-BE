import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HolidaySource, HolidayType } from './holiday.constants';
import { ErrorCode } from '../../common/errors/error-codes';

interface GoogleEvent {
  summary?: string;
  start?: { date?: string; dateTime?: string };
}

/** One holiday as it comes back from Google, before it meets the database. */
export interface FetchedHoliday {
  date: Date;
  name: string;
}

const DEFAULT_VN_HOLIDAY_CALENDAR_ID =
  'vi.vietnamese#holiday@group.v.calendar.google.com';

/** Pulls Vietnam's public holidays from Google Calendar into a tenant's calendar. The rule that matters: a row the tenant has touched is never overwritten, including one they switched off. */
@Injectable()
export class HolidaySyncService {
  private readonly logger = new Logger(HolidaySyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  private calendarId(): string {
    return (
      process.env.GOOGLE_VN_HOLIDAY_CALENDAR_ID ??
      DEFAULT_VN_HOLIDAY_CALENDAR_ID
    );
  }

  /** An all-day event carries `start.date`; a timed one only `start.dateTime`. */
  private eventDate(event: GoogleEvent): Date | null {
    const text = event.start?.date ?? event.start?.dateTime?.slice(0, 10);
    if (!text) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  async fetchFromGoogle(year: number): Promise<FetchedHoliday[]> {
    const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
    if (!apiKey) {
      throw new BadRequestException({
        code: ErrorCode.GOOGLE_CALENDAR_NOT_CONFIGURED,
        message: 'GOOGLE_CALENDAR_API_KEY is not configured on this server',
      });
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        this.calendarId(),
      )}/events`,
    );
    url.searchParams.set('key', apiKey);
    url.searchParams.set('timeMin', `${year}-01-01T00:00:00.000Z`);
    url.searchParams.set('timeMax', `${year + 1}-01-01T00:00:00.000Z`);
    // Recurring holidays are expanded into one event per occurrence.
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '2500');

    const response = await fetch(url);
    if (!response.ok) {
      throw new BadRequestException({
        code: ErrorCode.GOOGLE_CALENDAR_SYNC_FAILED,
        message: `Google Calendar sync failed: ${response.status} ${await response.text()}`,
      });
    }

    const body = (await response.json()) as { items?: GoogleEvent[] };
    return (body.items ?? [])
      .map((event) => ({ date: this.eventDate(event), name: event.summary }))
      .filter(
        (holiday): holiday is FetchedHoliday =>
          holiday.date !== null && Boolean(holiday.name),
      );
  }

  /** Syncs one tenant, one year. Prisma has no bulk upsert, so this loops inside one transaction - a partial sync leaving half a year updated would be worse than one that failed outright. */
  async syncVietnamPublicHolidays(tenantId: string, year: number) {
    const holidays = await this.fetchFromGoogle(year);
    if (holidays.length === 0) {
      return {
        message: 'Không có ngày lễ để sync',
        data: [],
        syncedCount: 0,
        skippedManualCount: 0,
      };
    }

    const existing = await this.prisma.holiday.findMany({
      where: {
        tenantId,
        type: HolidayType.PUBLIC_HOLIDAY,
        branchId: null,
        date: { in: holidays.map((holiday) => holiday.date) },
      },
      select: { id: true, date: true, isManuallyEdited: true },
    });
    const byDate = new Map(
      existing.map((row) => [row.date.toISOString().slice(0, 10), row]),
    );

    let skippedManualCount = 0;
    let syncedCount = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const holiday of holidays) {
        const key = holiday.date.toISOString().slice(0, 10);
        const row = byDate.get(key);

        // Tenant edits always win over the external calendar, isActive: false included.
        if (row?.isManuallyEdited) {
          skippedManualCount += 1;
          continue;
        }

        const data = {
          name: holiday.name,
          isActive: true,
          source: HolidaySource.GOOGLE_CALENDAR,
          isManuallyEdited: false,
        };

        if (row) {
          await tx.holiday.update({ where: { id: row.id }, data });
        } else {
          await tx.holiday.create({
            data: {
              tenantId,
              date: holiday.date,
              type: HolidayType.PUBLIC_HOLIDAY,
              branchId: null,
              ...data,
            },
          });
        }
        syncedCount += 1;
      }
    });

    this.logger.log(
      `Tenant ${tenantId} ${year}: synced ${syncedCount}, skipped ${skippedManualCount} manual`,
    );
    return {
      message: 'Sync ngày lễ thành công',
      data: holidays,
      syncedCount,
      skippedManualCount,
    };
  }
}
