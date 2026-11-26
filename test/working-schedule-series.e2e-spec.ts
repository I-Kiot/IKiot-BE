import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from './../src/prisma/prisma.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { WorkingScheduleService } from './../src/modules/working-schedules/working-schedules.service';
import { ShiftTemplateService } from './../src/modules/shift-templates/shift-templates.service';
import { NotificationService } from './../src/modules/notifications/notifications.service';
import { toShiftTime } from './../src/modules/shift-templates/shift-time';
import { ErrorCode } from './../src/common/errors/error-codes';
import { SystemRole } from './../src/common/constants/system-role';
import { UserStatus } from './../src/common/constants/user-status';

/** Lịch lặp lại trên Postgres thật: sinh ca, bỏ qua ngày đã xếp, chặn chồng ca, dừng từ một ngày. */
describe('Working schedules – recurring series', () => {
  let prisma: PrismaService;
  let schedules: WorkingScheduleService;

  const tenantId = randomUUID();
  const actorId = randomUUID();
  const binhId = randomUUID();
  const anId = randomUUID();
  let morningId = '';
  let overlapId = '';

  const live = { status: { in: ['SCHEDULED', 'COMPLETED'] } };
  const linksOf = (seriesId: string) =>
    prisma.workingScheduleUser.findMany({
      where: { seriesId },
      include: { schedule: { select: { workDate: true, status: true } } },
      orderBy: { schedule: { workDate: 'asc' } },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        WorkingScheduleService,
        ShiftTemplateService,
        {
          provide: NotificationService,
          useValue: { notify: () => Promise.resolve() },
        },
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    schedules = moduleRef.get(WorkingScheduleService);

    await prisma.tenant.create({
      data: { id: tenantId, name: 'schedule-series-e2e' },
    });
    await prisma.user.createMany({
      data: [
        { id: actorId, systemRole: SystemRole.TENANT_OWNER },
        { id: binhId, systemRole: SystemRole.STAFF },
        { id: anId, systemRole: SystemRole.STAFF },
      ].map(({ id, systemRole }) => ({
        id,
        tenantId,
        systemRole,
        status: UserStatus.ACTIVE,
        phoneNumber: `wss-${id}`,
      })),
    });
    const template = (name: string, start: string, end: string) =>
      prisma.shiftTemplate.create({
        data: {
          tenantId,
          name,
          startTime: toShiftTime(start),
          endTime: toShiftTime(end),
        },
      });
    morningId = (await template('Ca sáng', '08:00', '12:00')).id;
    overlapId = (await template('Ca chồng', '10:00', '14:00')).id;
  });

  afterAll(async () => {
    await prisma.workingScheduleUser.deleteMany({
      where: { schedule: { tenantId } },
    });
    await prisma.workingSchedule.deleteMany({ where: { tenantId } });
    await prisma.workingScheduleSeries.deleteMany({ where: { tenantId } });
    await prisma.shiftTemplate.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('rosters every chosen weekday in the range, skipping a day already on that shift', async () => {
    // Bình đã được xếp tay vào thứ Tư 2026-12-02.
    await schedules.createBulk(tenantId, actorId, {
      schedules: [
        {
          userId: [binhId],
          shiftTemplateId: morningId,
          workDate: '2026-12-02',
        },
      ],
    });

    // T2-T6 từ thứ Ba 2026-12-01 tới thứ Hai 2026-12-07: 01, 02, 03, 04, 07.
    const result = await schedules.createSeries(tenantId, actorId, {
      userId: [binhId, anId],
      shiftTemplateId: morningId,
      startDate: '2026-12-01',
      endDate: '2026-12-07',
      weekdays: [1, 2, 3, 4, 5],
    });
    const seriesId = result.data.series.id;

    expect(result.data.series.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(result.data.skipped).toEqual([
      { userId: binhId, workDate: '2026-12-02' },
    ]);
    expect(result.data.createdCount).toBe(9);

    // Một ca mỗi ngày, cả hai người trên đó; ngày 02 là ca xếp tay đã có, không phải ca thứ hai.
    const rows = await prisma.workingSchedule.findMany({
      where: { tenantId, ...live },
      include: { assignedUsers: true },
      orderBy: { workDate: 'asc' },
    });
    expect(rows.map((r) => r.workDate!.toISOString().slice(0, 10))).toEqual([
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-07',
    ]);
    for (const row of rows) expect(row.assignedUsers).toHaveLength(2);
    // Lượt xếp tay của Bình ngày 02 không bị gắn vào chuỗi.
    const manual = rows[1].assignedUsers.find((a) => a.userId === binhId)!;
    expect(manual.seriesId).toBeNull();

    // Đọc lại: mỗi người mang `series` của họ.
    const one = await schedules.findOne(tenantId, rows[0].id);
    expect(one.assignedUsers.every((u) => u.series?.id === seriesId)).toBe(
      true,
    );
  });

  it('refuses a series that overlaps another shift for the same person, writing nothing', async () => {
    const before = await prisma.workingScheduleSeries.count({
      where: { tenantId },
    });
    await expect(
      schedules.createSeries(tenantId, actorId, {
        userId: [anId],
        shiftTemplateId: overlapId,
        startDate: '2026-12-03',
        endDate: '2026-12-04',
      }),
    ).rejects.toMatchObject({
      response: {
        code: ErrorCode.SCHEDULE_OVERLAP,
        errors: [
          { workDate: '2026-12-03', shiftName: 'Ca sáng' },
          { workDate: '2026-12-04', shiftName: 'Ca sáng' },
        ],
      },
    });
    expect(
      await prisma.workingScheduleSeries.count({ where: { tenantId } }),
    ).toBe(before);
  });

  it('rejects an inverted range and a range with no matching weekday', async () => {
    await expect(
      schedules.createSeries(tenantId, actorId, {
        userId: [anId],
        shiftTemplateId: morningId,
        startDate: '2026-12-10',
        endDate: '2026-12-09',
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.SCHEDULE_SERIES_RANGE_INVALID },
    });
    await expect(
      schedules.createSeries(tenantId, actorId, {
        userId: [anId],
        shiftTemplateId: morningId,
        startDate: '2026-12-08',
        endDate: '2026-12-09',
        weekdays: [0],
      }),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.SCHEDULE_SERIES_EMPTY },
    });
  });

  it('stops a series from a date: later days go, earlier days and manual assignments stay', async () => {
    const series = await prisma.workingScheduleSeries.findFirstOrThrow({
      where: { tenantId, status: 'ACTIVE' },
    });

    const stopped = await schedules.removeSeries(
      tenantId,
      series.id,
      '2026-12-02',
    );
    // An ngày 02, 03, 04, 07 + Bình ngày 03, 04, 07 (ngày 02 của Bình là lượt xếp tay).
    expect(stopped.data.removedCount).toBe(7);

    const links = await linksOf(series.id);
    expect(
      links.map((l) => l.schedule.workDate!.toISOString().slice(0, 10)),
    ).toEqual(['2026-12-01', '2026-12-01']);

    // Ngày 02 còn ca (Bình xếp tay), các ngày sau không còn ai nên bị xoá.
    const remaining = await prisma.workingSchedule.findMany({
      where: { tenantId, ...live },
      include: { assignedUsers: true },
      orderBy: { workDate: 'asc' },
    });
    expect(
      remaining.map((r) => r.workDate!.toISOString().slice(0, 10)),
    ).toEqual(['2026-12-01', '2026-12-02']);
    expect(remaining[1].assignedUsers.map((a) => a.userId)).toEqual([binhId]);

    const after = await prisma.workingScheduleSeries.findUniqueOrThrow({
      where: { id: series.id },
    });
    expect(after.endDate.toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(after.status).toBe('ACTIVE');

    // Dừng từ ngày đầu = xoá cả chuỗi.
    await schedules.removeSeries(tenantId, series.id, '2026-12-01');
    expect(
      (
        await prisma.workingScheduleSeries.findUniqueOrThrow({
          where: { id: series.id },
        })
      ).status,
    ).toBe('DELETED');
    await expect(
      schedules.removeSeries(tenantId, series.id),
    ).rejects.toMatchObject({
      response: { code: ErrorCode.SCHEDULE_SERIES_NOT_FOUND },
    });
  });
});
