import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ShiftTemplateService } from '../shift-templates/shift-templates.service';
import { NotificationService } from '../notifications/notifications.service';
import { ScheduleNotificationTemplates } from '../notifications/templates/schedule.templates';
import { fromShiftTime } from '../shift-templates/shift-time';
import { UserStatus } from '../../common/constants/user-status';
import { SystemRole } from '../../common/constants/system-role';
import { paginate, skipFor } from '../../common/utils/pagination';
import { businessDate } from '../cash-drawer-sessions/business-date';
import {
  dayTypeOf,
  isSunday,
  localDateText,
  shiftInterval,
  workDateOf,
} from './schedule-time';
import {
  MAX_SERIES_DAYS,
  SeriesStatus,
  normalizeWeekdays,
  previousDate,
  seriesDates,
  seriesSpanDays,
} from './schedule-series';
import {
  LIVE_SCHEDULE_STATUSES,
  ScheduleStatus,
} from './working-schedule.constants';
import {
  BulkCreateWorkingScheduleDto,
  CreateScheduleSeriesDto,
  QueryWorkingScheduleDto,
  UpdateWorkingScheduleDto,
} from './dto/working-schedule.dto';
import { withNestedProfile } from '../../common/utils/user-profile';
import {
  USER_POSTING_SELECT,
  postingWhere,
  withPosting,
} from '../../common/dto/location-ref.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const STAFF_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  ...USER_POSTING_SELECT,
} as const;

const SERIES_REF_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  weekdays: true,
  status: true,
} as const satisfies Prisma.WorkingScheduleSeriesSelect;

const SERIES_SELECT = {
  ...SERIES_REF_SELECT,
  shiftTemplateId: true,
  users: { select: { userId: true } },
} as const satisfies Prisma.WorkingScheduleSeriesSelect;

const SCHEDULE_INCLUDE = {
  shiftTemplate: true,
  assignedUsers: {
    include: {
      user: { select: STAFF_SELECT },
      series: { select: SERIES_REF_SELECT },
    },
  },
} as const satisfies Prisma.WorkingScheduleInclude;

type ScheduleRow = Prisma.WorkingScheduleGetPayload<{
  include: typeof SCHEDULE_INCLUDE;
}>;

type SeriesRef = Prisma.WorkingScheduleSeriesGetPayload<{
  select: typeof SERIES_REF_SELECT;
}>;

type SeriesRow = Prisma.WorkingScheduleSeriesGetPayload<{
  select: typeof SERIES_SELECT;
}>;

type Db = Prisma.TransactionClient | PrismaService;

interface AssignmentInput {
  userIds: string[];
  shiftTemplateId: string;
  workDate: string;
}

interface ResolvedAssignment {
  userIds: string[];
  shiftTemplateId: string;
  shiftName: string;
  workDate: Date;
  startAt: Date;
  endAt: Date;
}

interface SlotFields {
  shiftTemplateId: string | null;
  workDate: Date | null;
  startAt: Date | null;
  endAt: Date | null;
}

interface LiveSlot {
  id: string;
  shiftName: string;
  userIds: Set<string>;
}

/** Ca mẫu + ngày + giờ: hai lịch cùng khoá là cùng một ca (unique `working_schedules_one_per_slot`). */
function slotKey(slot: SlotFields): string {
  return [
    slot.shiftTemplateId,
    slot.workDate?.toISOString(),
    slot.startAt?.toISOString(),
    slot.endAt?.toISOString(),
  ].join('|');
}

function seriesRefOf(series: SeriesRef | null) {
  if (!series) return null;
  return {
    id: series.id,
    startDate: localDateText(series.startDate),
    endDate: localDateText(series.endDate),
    weekdays: series.weekdays,
    status: series.status,
  };
}

/** Lịch làm việc: một ca nhiều người, xếp theo lô hoặc theo lịch lặp lại. */
@Injectable()
export class WorkingScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shiftTemplates: ShiftTemplateService,
    private readonly notifications: NotificationService,
  ) {}

  /** Gộp các dòng cùng slot thành một lịch. */
  async createBulk(
    tenantId: string,
    actorId: string,
    dto: BulkCreateWorkingScheduleDto,
  ) {
    const resolved = await this.resolveAssignments(
      tenantId,
      dto.schedules.map((row) => ({
        userIds: row.userId,
        shiftTemplateId: row.shiftTemplateId,
        workDate: row.workDate,
      })),
    );
    const merged = this.mergeBySlot(resolved);
    // Kiểm tra cả lô trước khi ghi bất cứ gì, để một dòng trùng không để lại các dòng trước đó đã lưu dở.
    const existing = await this.liveSlots(this.prisma, tenantId, merged);
    this.assertNotAlreadyAssigned(merged, existing);
    await this.assertNoOverlap(tenantId, merged);

    const ids = await this.prisma.$transaction((tx) =>
      this.persist(tx, tenantId, actorId, merged, null),
    );
    const saved = await this.prisma.workingSchedule.findMany({
      where: { id: { in: ids } },
      include: SCHEDULE_INCLUDE,
      orderBy: [{ workDate: 'asc' }, { startAt: 'asc' }],
    });

    await this.notifyAssigned(
      tenantId,
      actorId,
      merged.flatMap((a) => a.userIds),
    );

    return {
      message: 'Phân ca thành công',
      data: saved.map((row) => this.toResponse(row)),
    };
  }

  /**
   * Lịch lặp lại: sinh sẵn mọi ngày khớp thành ca như phân ca tay, mỗi lượt mang `seriesId`.
   * Ngày người đó đã ở đúng ca này (xếp tay trước đó) được bỏ qua chứ không 409: họ vẫn làm
   * ca đó. Chồng giờ với ca khác thì 409 và không ghi gì, kèm danh sách ngày bị chồng.
   */
  async createSeries(
    tenantId: string,
    actorId: string,
    dto: CreateScheduleSeriesDto,
  ) {
    const startDate = localDateText(dto.startDate);
    const endDate = localDateText(dto.endDate);
    if (startDate > endDate) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_SERIES_RANGE_INVALID,
        message: 'The end date cannot be before the start date',
      });
    }
    if (seriesSpanDays(startDate, endDate) > MAX_SERIES_DAYS) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_SERIES_RANGE_INVALID,
        message: `A recurring schedule can span at most ${MAX_SERIES_DAYS} days`,
      });
    }
    const weekdays = normalizeWeekdays(dto.weekdays);
    const dates = seriesDates(startDate, endDate, weekdays);
    if (dates.length === 0) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_SERIES_EMPTY,
        message: 'No day in the range falls on the chosen weekdays',
      });
    }

    const userIds = [...new Set(dto.userId)];
    const resolved = await this.resolveAssignments(
      tenantId,
      dates.map((workDate) => ({
        userIds,
        shiftTemplateId: dto.shiftTemplateId,
        workDate,
      })),
    );

    const existing = await this.liveSlots(this.prisma, tenantId, resolved);
    const skipped: { userId: string; workDate: string }[] = [];
    const toWrite: ResolvedAssignment[] = [];
    for (const assignment of resolved) {
      const onShift = existing.get(slotKey(assignment))?.userIds;
      const fresh = assignment.userIds.filter((id) => !onShift?.has(id));
      for (const userId of assignment.userIds) {
        if (onShift?.has(userId)) {
          skipped.push({
            userId,
            workDate: localDateText(assignment.workDate),
          });
        }
      }
      if (fresh.length > 0) toWrite.push({ ...assignment, userIds: fresh });
    }
    await this.assertNoOverlap(tenantId, toWrite);

    const series = await this.prisma.$transaction(
      async (tx) => {
        const row = await tx.workingScheduleSeries.create({
          data: {
            tenantId,
            shiftTemplateId: dto.shiftTemplateId,
            startDate: workDateOf(startDate),
            endDate: workDateOf(endDate),
            weekdays,
            status: SeriesStatus.ACTIVE,
            createdById: actorId,
            users: { create: userIds.map((userId) => ({ userId })) },
          },
          select: SERIES_SELECT,
        });
        await this.persist(tx, tenantId, actorId, toWrite, row.id);
        return row;
      },
      // Một năm nhiều người là vài nghìn dòng; mặc định 5 s không đủ trên máy chậm.
      { timeout: 30_000 },
    );

    await this.notifyAssigned(tenantId, actorId, userIds);

    return {
      message: 'Đã tạo lịch lặp lại',
      data: {
        series: this.toSeriesResponse(series),
        createdCount: toWrite.reduce((n, a) => n + a.userIds.length, 0),
        skipped,
      },
    };
  }

  /**
   * Dừng lịch lặp từ `fromDate` (mặc định hôm nay): gỡ các lượt của chuỗi ở các ca còn
   * SCHEDULED từ ngày đó, ca không còn ai thì xoá. Ca đã qua giữ nguyên làm lịch sử; lượt
   * xếp tay cùng ca không bị đụng. Chuỗi được cắt ngắn, hoặc xoá nếu dừng từ ngày đầu.
   */
  async removeSeries(tenantId: string, id: string, fromDate?: string) {
    const series = await this.prisma.workingScheduleSeries.findFirst({
      where: { id, tenantId, status: SeriesStatus.ACTIVE },
      select: { id: true, startDate: true, endDate: true },
    });
    if (!series) {
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_SERIES_NOT_FOUND,
        message: 'Recurring schedule not found',
      });
    }

    const from = fromDate
      ? localDateText(fromDate)
      : localDateText(businessDate());
    const fromDay = workDateOf(from);

    const removedCount = await this.prisma.$transaction(async (tx) => {
      const links = await tx.workingScheduleUser.findMany({
        where: {
          seriesId: id,
          schedule: {
            tenantId,
            status: ScheduleStatus.SCHEDULED,
            workDate: { gte: fromDay },
          },
        },
        select: { scheduleId: true },
      });
      const scheduleIds = [...new Set(links.map((l) => l.scheduleId))];
      if (scheduleIds.length > 0) {
        await tx.workingScheduleUser.deleteMany({
          where: { seriesId: id, scheduleId: { in: scheduleIds } },
        });
        // Gỡ người cuối cùng thì xoá cả ca, như `removeUser`.
        await tx.workingSchedule.updateMany({
          where: { id: { in: scheduleIds }, assignedUsers: { none: {} } },
          data: { status: ScheduleStatus.DELETED },
        });
      }

      if (fromDay <= series.startDate) {
        await tx.workingScheduleSeries.update({
          where: { id },
          data: { status: SeriesStatus.DELETED },
        });
      } else {
        const lastDay = workDateOf(previousDate(from));
        if (lastDay < series.endDate) {
          await tx.workingScheduleSeries.update({
            where: { id },
            data: { endDate: lastDay },
          });
        }
      }
      return links.length;
    });

    return {
      message: 'Đã dừng lịch lặp lại',
      data: { id, fromDate: from, removedCount },
    };
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateWorkingScheduleDto,
  ) {
    const current = await this.prisma.workingSchedule.findFirst({
      where: { id, tenantId, status: ScheduleStatus.SCHEDULED },
      select: {
        id: true,
        shiftTemplateId: true,
        workDate: true,
        assignedUsers: { select: { userId: true, seriesId: true } },
      },
    });
    if (!current) {
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_NOT_EDITABLE,
        message: 'No editable working schedule found',
      });
    }

    const [assignment] = await this.resolveAssignments(tenantId, [
      {
        userIds: dto.userId,
        shiftTemplateId: dto.shiftTemplateId,
        workDate: dto.workDate,
      },
    ]);
    await this.assertNoOverlap(tenantId, [assignment], id);

    // Còn đúng ca + ngày thì người ở lại vẫn thuộc lịch lặp của họ; đổi ca / ngày là ngoại lệ riêng.
    const sameSlot =
      current.shiftTemplateId === assignment.shiftTemplateId &&
      current.workDate?.getTime() === assignment.workDate.getTime();
    const seriesOf = new Map(
      current.assignedUsers.map((a) => [a.userId, a.seriesId]),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.workingScheduleUser.deleteMany({ where: { scheduleId: id } });
      return tx.workingSchedule.update({
        where: { id },
        data: {
          shiftTemplateId: assignment.shiftTemplateId,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
          managedById: actorId,
          assignedUsers: {
            create: assignment.userIds.map((userId) => ({
              userId,
              seriesId: sameSlot ? (seriesOf.get(userId) ?? null) : null,
            })),
          },
        },
        include: SCHEDULE_INCLUDE,
      });
    });

    return {
      message: 'Cập nhật lịch làm việc thành công',
      data: this.toResponse(updated),
    };
  }

  async findAll(tenantId: string, query: QueryWorkingScheduleDto) {
    const where = this.buildWhere(tenantId, query);

    const [rows, total] = await Promise.all([
      this.prisma.workingSchedule.findMany({
        where,
        include: SCHEDULE_INCLUDE,
        orderBy: [
          { workDate: 'asc' },
          { startAt: 'asc' },
          { createdAt: 'asc' },
        ],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.workingSchedule.count({ where }),
    ]);

    const decorated = await this.decorate(tenantId, rows);
    return paginate(decorated, total, query.page, query.limit);
  }

  async findMine(
    tenantId: string,
    userId: string,
    query: QueryWorkingScheduleDto,
  ) {
    const result = await this.findAll(tenantId, { ...query, userId });
    return {
      ...result,
      data: result.data.map((schedule) => ({
        ...schedule,
        assignedUsers: schedule.assignedUsers.filter(
          (assigned) => assigned.id === userId,
        ),
      })),
    };
  }

  /** Ca hiện tại, null nếu không có; kèm giờ server. */
  async findCurrent(tenantId: string, userId: string) {
    const now = new Date();
    const schedule = await this.prisma.workingSchedule.findFirst({
      where: {
        tenantId,
        status: ScheduleStatus.SCHEDULED,
        startAt: { lte: now },
        endAt: { gt: now },
        assignedUsers: { some: { userId } },
      },
      include: SCHEDULE_INCLUDE,
    });

    if (!schedule) {
      return {
        data: null,
        message: 'Không có ca làm việc hiện tại',
        serverTime: now.toISOString(),
      };
    }

    const [decorated] = await this.decorate(tenantId, [schedule]);
    return { data: decorated, serverTime: now.toISOString() };
  }

  /** Chi nhánh/kho là query param bắt buộc (route cũ trả 400 khi thiếu); validation lo việc báo lỗi. */
  async findByLocation(
    tenantId: string,
    query: QueryWorkingScheduleDto,
    kind: 'branch' | 'warehouse',
  ) {
    const locationId = kind === 'branch' ? query.branchId : query.warehouseId;
    if (!locationId) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_LOCATION_REQUIRED,
        message:
          kind === 'branch'
            ? 'branchId is required'
            : 'warehouseId is required',
      });
    }
    return this.findAll(tenantId, query);
  }

  async findOne(tenantId: string, id: string) {
    const schedule = await this.prisma.workingSchedule.findFirst({
      where: { id, tenantId, status: { not: ScheduleStatus.DELETED } },
      include: SCHEDULE_INCLUDE,
    });
    if (!schedule)
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_NOT_FOUND,
        message: 'Working schedule not found',
      });

    const [decorated] = await this.decorate(tenantId, [schedule]);
    return decorated;
  }

  async findUserDetail(tenantId: string, id: string, userId: string) {
    const schedule = await this.findOne(tenantId, id);
    const user = schedule.assignedUsers.find(
      (assigned) => assigned.id === userId,
    );
    if (!user) {
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_USER_NOT_ASSIGNED,
        message: 'This employee is not on this working schedule',
      });
    }

    const { assignedUsers: _assigned, ...rest } = schedule;
    return { ...rest, user };
  }

  async remove(tenantId: string, id: string) {
    const schedule = await this.prisma.workingSchedule.findFirst({
      where: { id, tenantId, status: { not: ScheduleStatus.DELETED } },
      select: { id: true, status: true },
    });
    if (!schedule)
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_NOT_FOUND,
        message: 'Working schedule not found',
      });
    if (schedule.status === ScheduleStatus.COMPLETED) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_COMPLETED_CANNOT_DELETE,
        message: 'A completed working schedule cannot be deleted',
      });
    }

    await this.prisma.workingSchedule.update({
      where: { id },
      data: { status: ScheduleStatus.DELETED },
    });
    return { message: 'Xóa lịch làm việc thành công', data: { id } };
  }

  /** Gỡ một người khỏi ca; gỡ người cuối cùng thì xoá cả ca, vì ca rỗng nghĩa là không ai làm. */
  async removeUser(tenantId: string, id: string, userId: string) {
    const schedule = await this.prisma.workingSchedule.findFirst({
      where: {
        id,
        tenantId,
        status: { not: ScheduleStatus.DELETED },
        assignedUsers: { some: { userId } },
      },
      include: { assignedUsers: { select: { userId: true } } },
    });
    if (!schedule) {
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_USER_NOT_ASSIGNED,
        message: 'Employee not found on this shift',
      });
    }

    if (schedule.assignedUsers.length === 1) {
      return this.remove(tenantId, id);
    }

    await this.prisma.workingScheduleUser.delete({
      where: { scheduleId_userId: { scheduleId: id, userId } },
    });
    return {
      message: 'Đã gỡ nhân viên khỏi ca làm việc',
      data: { id, userId },
    };
  }

  private async resolveAssignments(
    tenantId: string,
    assignments: AssignmentInput[],
  ): Promise<ResolvedAssignment[]> {
    const userIds = [
      ...new Set(assignments.flatMap((assignment) => assignment.userIds)),
    ];
    await this.assertStaffOfTenant(tenantId, userIds);

    const templates = await this.shiftTemplates.activeByIds(
      tenantId,
      assignments.map((assignment) => assignment.shiftTemplateId),
    );

    return assignments.map((assignment) => {
      const template = templates.get(assignment.shiftTemplateId)!;
      const { startAt, endAt } = shiftInterval(assignment.workDate, template);
      return {
        userIds: [...new Set(assignment.userIds)],
        shiftTemplateId: assignment.shiftTemplateId,
        shiftName: template.name ?? 'shift',
        workDate: workDateOf(assignment.workDate),
        startAt,
        endAt,
      };
    });
  }

  /** Người được xếp ca phải là nhân viên đang hoạt động. */
  private async assertStaffOfTenant(tenantId: string, userIds: string[]) {
    if (userIds.length === 0) return;
    const found = await this.prisma.user.count({
      where: {
        id: { in: userIds },
        tenantId,
        systemRole: SystemRole.STAFF,
        status: UserStatus.ACTIVE,
      },
    });
    if (found !== userIds.length) {
      throw new BadRequestException({
        code: ErrorCode.SCHEDULE_STAFF_INVALID,
        message: 'One or more employees are invalid',
      });
    }
  }

  private mergeBySlot(assignments: ResolvedAssignment[]): ResolvedAssignment[] {
    const bySlot = new Map<string, ResolvedAssignment>();
    for (const assignment of assignments) {
      const key = slotKey(assignment);
      const existing = bySlot.get(key);
      if (!existing) {
        bySlot.set(key, { ...assignment, userIds: [...assignment.userIds] });
        continue;
      }
      for (const userId of assignment.userIds) {
        if (!existing.userIds.includes(userId)) existing.userIds.push(userId);
      }
    }
    return [...bySlot.values()];
  }

  /** Các ca còn sống trùng slot với `assignments`, theo `slotKey`. Một query cho cả lô. */
  private async liveSlots(
    db: Db,
    tenantId: string,
    assignments: ResolvedAssignment[],
  ): Promise<Map<string, LiveSlot>> {
    if (assignments.length === 0) return new Map();
    const rows = await db.workingSchedule.findMany({
      where: {
        tenantId,
        status: { in: LIVE_SCHEDULE_STATUSES },
        OR: assignments.map((assignment) => ({
          shiftTemplateId: assignment.shiftTemplateId,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
        })),
      },
      select: {
        id: true,
        shiftTemplateId: true,
        workDate: true,
        startAt: true,
        endAt: true,
        shiftTemplate: { select: { name: true } },
        assignedUsers: { select: { userId: true } },
      },
    });
    return new Map(
      rows.map((row) => [
        slotKey(row),
        {
          id: row.id,
          shiftName: row.shiftTemplate?.name ?? 'shift',
          userIds: new Set(row.assignedUsers.map((a) => a.userId)),
        },
      ]),
    );
  }

  /**
   * Ghi các lượt phân công: ca chưa có thì tạo, rồi thêm người chưa ở ca. Trả id các ca.
   * Đọc lại slot trong transaction; hai request đua tạo cùng ca thì unique một-phần chặn
   * request sau (P2002 → 409).
   */
  private async persist(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actorId: string,
    assignments: ResolvedAssignment[],
    seriesId: string | null,
  ): Promise<string[]> {
    if (assignments.length === 0) return [];
    const existing = await this.liveSlots(tx, tenantId, assignments);

    const missing = assignments.filter((a) => !existing.has(slotKey(a)));
    const created =
      missing.length === 0
        ? []
        : await tx.workingSchedule.createManyAndReturn({
            data: missing.map((assignment) => ({
              tenantId,
              createdById: actorId,
              managedById: actorId,
              shiftTemplateId: assignment.shiftTemplateId,
              workDate: assignment.workDate,
              startAt: assignment.startAt,
              endAt: assignment.endAt,
              status: ScheduleStatus.SCHEDULED,
            })),
            select: {
              id: true,
              shiftTemplateId: true,
              workDate: true,
              startAt: true,
              endAt: true,
            },
          });

    const idByKey = new Map<string, string>();
    for (const [key, slot] of existing) idByKey.set(key, slot.id);
    for (const row of created) idByKey.set(slotKey(row), row.id);

    const links = assignments.flatMap((assignment) => {
      const key = slotKey(assignment);
      const onShift = existing.get(key)?.userIds;
      return assignment.userIds
        .filter((userId) => !onShift?.has(userId))
        .map((userId) => ({ scheduleId: idByKey.get(key)!, userId, seriesId }));
    });
    if (links.length > 0) {
      await tx.workingScheduleUser.createMany({ data: links });
    }

    const touched = [...existing.values()].map((slot) => slot.id);
    if (touched.length > 0) {
      await tx.workingSchedule.updateMany({
        where: { id: { in: touched } },
        data: { managedById: actorId },
      });
    }

    return [...new Set(assignments.map((a) => idByKey.get(slotKey(a))!))];
  }

  /** Từ chối xếp lại người vào đúng ca họ đã có. Không ghi gì nếu có một dòng trùng. */
  private assertNotAlreadyAssigned(
    assignments: ResolvedAssignment[],
    existing: Map<string, LiveSlot>,
  ) {
    const duplicates: {
      userId: string;
      workDate: string;
      shiftName: string;
    }[] = [];
    for (const assignment of assignments) {
      const slot = existing.get(slotKey(assignment));
      if (!slot) continue;
      for (const userId of assignment.userIds) {
        if (!slot.userIds.has(userId)) continue;
        duplicates.push({
          userId,
          workDate: localDateText(assignment.workDate),
          shiftName: slot.shiftName,
        });
      }
    }

    if (duplicates.length > 0) {
      throw new ConflictException({
        code: ErrorCode.SCHEDULE_ALREADY_ASSIGNED,
        message: 'One or more employees are already assigned to this shift',
        errors: duplicates,
      });
    }
  }

  /**
   * Không ai ở hai ca chồng giờ nhau: so với ca đã lưu (một query cho cả lô) và giữa các
   * dòng của chính lô. Cùng slot là gộp, không phải chồng - đó là cách thêm người vào ca đã có.
   */
  private async assertNoOverlap(
    tenantId: string,
    assignments: ResolvedAssignment[],
    excludeScheduleId?: string,
  ) {
    if (assignments.length === 0) return;
    const userIds = [...new Set(assignments.flatMap((a) => a.userIds))];
    const minStart = new Date(
      Math.min(...assignments.map((a) => a.startAt.getTime())),
    );
    const maxEnd = new Date(
      Math.max(...assignments.map((a) => a.endAt.getTime())),
    );

    const rows = await this.prisma.workingSchedule.findMany({
      where: {
        tenantId,
        status: { in: LIVE_SCHEDULE_STATUSES },
        ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
        assignedUsers: { some: { userId: { in: userIds } } },
        startAt: { lt: maxEnd },
        endAt: { gt: minStart },
      },
      select: {
        shiftTemplateId: true,
        workDate: true,
        startAt: true,
        endAt: true,
        shiftTemplate: { select: { name: true } },
        assignedUsers: {
          where: { userId: { in: userIds } },
          select: { userId: true },
        },
      },
    });
    const stored = rows.map((row) => ({
      key: slotKey(row),
      startAt: row.startAt!,
      endAt: row.endAt!,
      workDate: row.workDate,
      shiftName: row.shiftTemplate?.name ?? 'shift',
      userIds: row.assignedUsers.map((a) => a.userId),
    }));
    const batch = assignments.map((a) => ({ ...a, key: slotKey(a) }));

    const clashes: { workDate: string; shiftName: string }[] = [];
    for (const [index, assignment] of batch.entries()) {
      const others = [...stored, ...batch.slice(index + 1)];
      const clash = others.find(
        (other) =>
          other.key !== assignment.key &&
          other.startAt < assignment.endAt &&
          other.endAt > assignment.startAt &&
          other.userIds.some((id) => assignment.userIds.includes(id)),
      );
      if (clash) {
        clashes.push({
          workDate: localDateText(clash.workDate ?? assignment.workDate),
          shiftName: clash.shiftName,
        });
      }
    }

    if (clashes.length > 0) {
      const [first] = clashes;
      throw new ConflictException({
        code: ErrorCode.SCHEDULE_OVERLAP,
        message: `Overlaps ${first.shiftName} on ${first.workDate}`,
        errors: clashes,
      });
    }
  }

  private async notifyAssigned(
    tenantId: string,
    actorId: string,
    userIds: string[],
  ) {
    // Mỗi người một thông báo.
    const recipients = [...new Set(userIds)].filter((id) => id !== actorId);
    await this.notifications.notify({
      tenantId,
      recipientIds: recipients,
      ...ScheduleNotificationTemplates.assigned(),
    });
  }

  // ─── Bộ lọc ───

  private buildWhere(
    tenantId: string,
    query: QueryWorkingScheduleDto,
  ): Prisma.WorkingScheduleWhereInput {
    const where: Prisma.WorkingScheduleWhereInput = {
      tenantId,
      status: query.status ?? { not: ScheduleStatus.DELETED },
    };

    const assigned: Prisma.WorkingScheduleUserWhereInput = {};
    if (query.userId) assigned.userId = query.userId;
    if (query.branchId || query.warehouseId) {
      assigned.user = {
        tenantId,
        status: { not: UserStatus.DELETED },
        ...postingWhere(query),
      };
    }
    if (Object.keys(assigned).length > 0) {
      where.assignedUsers = { some: assigned };
    }

    if (query.startDate || query.endDate) {
      if (
        query.startDate &&
        query.endDate &&
        workDateOf(query.startDate) > workDateOf(query.endDate)
      ) {
        throw new BadRequestException({
          code: ErrorCode.DATE_RANGE_INVALID,
          message: 'The start date cannot be after the end date',
        });
      }
      const range: Prisma.DateTimeFilter = {};
      if (query.startDate) range.gte = workDateOf(query.startDate);
      if (query.endDate) {
        // Biên trên mở: lùi sang ngày kế tiếp để `endDate` vẫn được tính đủ cả ngày.
        const next = workDateOf(query.endDate);
        next.setUTCDate(next.getUTCDate() + 1);
        range.lt = next;
      }
      where.workDate = range;
    }

    return where;
  }

  // ─── Trang trí ───

  private async decorate(tenantId: string, rows: ScheduleRow[]) {
    if (rows.length === 0) return [];

    const holidayNames = await this.holidaysIn(tenantId, rows);

    return rows.map((row) => {
      const dateText = row.workDate ? localDateText(row.workDate) : null;
      const holiday = dateText ? (holidayNames.get(dateText) ?? null) : null;
      const sunday = row.workDate ? isSunday(row.workDate) : false;

      return {
        ...this.toResponse(row),
        dayInfo: {
          dayType: dayTypeOf(sunday, Boolean(holiday)),
          isSunday: sunday,
          isHoliday: Boolean(holiday),
          holidayName: holiday?.name ?? null,
          holidayType: holiday?.type ?? null,
        },
        // Cùng cấu trúc lồng với `/users`: tên nhân viên nằm dưới `profile` ở mọi nơi.
        // `series` khác null = lượt này đến từ một lịch lặp lại.
        assignedUsers: row.assignedUsers.map((assigned) => ({
          ...withNestedProfile(withPosting(assigned.user)),
          series: seriesRefOf(assigned.series),
        })),
      };
    });
  }

  private async holidaysIn(tenantId: string, rows: ScheduleRow[]) {
    const dates = rows
      .map((row) => row.workDate)
      .filter((date): date is Date => date !== null);
    if (dates.length === 0) {
      return new Map<string, { name: string; type: string }>();
    }

    const holidays = await this.prisma.holiday.findMany({
      where: {
        tenantId,
        isActive: true,
        branchId: null,
        date: {
          gte: new Date(Math.min(...dates.map((d) => d.getTime()))),
          lte: new Date(Math.max(...dates.map((d) => d.getTime()))),
        },
      },
      select: { date: true, name: true, type: true },
    });
    return new Map(
      holidays.map((holiday) => [
        localDateText(holiday.date),
        { name: holiday.name, type: holiday.type },
      ]),
    );
  }

  private toResponse(row: ScheduleRow) {
    const { shiftTemplate, assignedUsers, ...rest } = row;
    return {
      ...rest,
      shiftTemplate: shiftTemplate
        ? {
            ...shiftTemplate,
            startTime: fromShiftTime(shiftTemplate.startTime),
            endTime: fromShiftTime(shiftTemplate.endTime),
          }
        : null,
      assignedUsers: assignedUsers.map((assigned) => ({
        ...withPosting(assigned.user),
        series: seriesRefOf(assigned.series),
      })),
    };
  }

  private toSeriesResponse(row: SeriesRow) {
    const { users, shiftTemplateId, ...ref } = row;
    return {
      ...seriesRefOf(ref)!,
      shiftTemplateId,
      userIds: users.map((u) => u.userId),
    };
  }
}
