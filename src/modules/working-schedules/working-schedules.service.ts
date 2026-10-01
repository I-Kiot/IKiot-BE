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
import {
  dayTypeOf,
  isSunday,
  lateMinutesOf,
  localDateText,
  overlapMinutes,
  shiftInterval,
  workDateOf,
} from './schedule-time';
import {
  DEFAULT_LATE_GRACE_MINUTES,
  LIVE_SCHEDULE_STATUSES,
  ScheduleStatus,
  ScheduleType,
} from './working-schedule.constants';
import {
  BulkCreateWorkingScheduleDto,
  QueryWorkingScheduleDto,
  ScheduleAssignmentDto,
  UpdateWorkingScheduleDto,
} from './dto/working-schedule.dto';
import { withNestedProfile } from '../../common/utils/user-profile';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const STAFF_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  branchId: true,
  warehouseId: true,
} as const;

const SCHEDULE_INCLUDE = {
  shiftTemplate: true,
  assignedUsers: { include: { user: { select: STAFF_SELECT } } },
} as const satisfies Prisma.WorkingScheduleInclude;

type ScheduleRow = Prisma.WorkingScheduleGetPayload<{
  include: typeof SCHEDULE_INCLUDE;
}>;

type AttendanceRow = Prisma.AttendanceGetPayload<object>;

/** One assignment, resolved to real instants and ready to be written. */
interface ResolvedAssignment {
  userIds: string[];
  shiftTemplateId: string;
  scheduleType: string;
  workDate: Date;
  startAt: Date;
  endAt: Date;
}

/** Who works when. A schedule is one shift on one day with several people on it, and assignment is bulk by design, since a manager rosters a week at a time. Two things the old service carried are deliberately gone: `deduplicateWorkingSchedules` (~150 lines that normalised duplicates in the response and forced in-memory pagination - Postgres forbids them with a partial unique index instead), and `validateRoleHierarchy`, whose roles no longer exist. */
@Injectable()
export class WorkingScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shiftTemplates: ShiftTemplateService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Create / update ───────────────────────────────────────────────────────

  /** Rosters a batch of shifts. Assignments landing on the same slot are merged into one schedule rather than written twice, which is what makes "add Bình to Tuesday's morning shift" work when that shift is already rostered. */
  async createBulk(
    tenantId: string,
    actorId: string,
    dto: BulkCreateWorkingScheduleDto,
  ) {
    const resolved = await this.resolveAssignments(tenantId, dto.schedules);
    const merged = this.mergeBySlot(resolved);

    const saved: ScheduleRow[] = [];
    for (const assignment of merged) {
      await this.assertNoOverlap(tenantId, assignment);
      saved.push(await this.upsertSlot(tenantId, actorId, assignment));
    }

    // One notification per person, not per row: rostering a week creates five schedules for the same employee. The actor is excluded - you don't need telling about the roster you just wrote.
    const recipients = [
      ...new Set(
        saved.flatMap((row) => row.assignedUsers.map((a) => a.userId)),
      ),
    ].filter((id) => id !== actorId);
    await this.notifications.notify({
      tenantId,
      recipientIds: recipients,
      ...ScheduleNotificationTemplates.assigned(),
    });

    return {
      message: 'Phân ca thành công',
      data: saved.map((row) => this.toResponse(row)),
    };
  }

  /** Replaces one schedule's people, shift and day. Refused once anyone has clocked in against it: an attendance row points at a `startAt` that lateness was computed from, and moving the shift under it rewrites history. */
  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateWorkingScheduleDto,
  ) {
    const current = await this.prisma.workingSchedule.findFirst({
      where: { id, tenantId, status: ScheduleStatus.SCHEDULED },
      select: { id: true },
    });
    if (!current) {
      throw new NotFoundException({
        code: ErrorCode.SCHEDULE_NOT_EDITABLE,
        message: 'No editable working schedule found',
      });
    }
    await this.assertNoAttendance(
      tenantId,
      id,
      undefined,
      'A shift with attendance recorded against it cannot be edited',
    );

    const [assignment] = await this.resolveAssignments(tenantId, [dto]);
    await this.assertNoOverlap(tenantId, assignment, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.workingScheduleUser.deleteMany({ where: { scheduleId: id } });
      return tx.workingSchedule.update({
        where: { id },
        data: {
          shiftTemplateId: assignment.shiftTemplateId,
          scheduleType: assignment.scheduleType,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
          managedById: actorId,
          assignedUsers: {
            create: assignment.userIds.map((userId) => ({ userId })),
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

  // ─── Reads ─────────────────────────────────────────────────────────────────

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

    const decorated = await this.decorate(tenantId, rows, false);
    return paginate(decorated, total, query.page, query.limit);
  }

  /** `GET /working-schedules/me` - the caller's own roster, trimmed to just them. */
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

  /** The shift this person is in right now, if any. Answers `{ data: null }` rather than a 404 - a till asks this on startup and "you are not on shift" is a normal answer - with `serverTime` alongside so the client needn't trust its own clock. */
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

    const [decorated] = await this.decorate(tenantId, [schedule], true);
    return { data: decorated, serverTime: now.toISOString() };
  }

  /** The branch / warehouse views. The old routes were two near-identical wrappers that each answered 400 when their id was missing; here it is a required query param, so the validation layer says so. */
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

    const [decorated] = await this.decorate(tenantId, [schedule], true);
    return decorated;
  }

  /** One person's slice of one schedule - their attendance, without the rest of the team. */
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

  // ─── Delete ────────────────────────────────────────────────────────────────

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
    await this.assertNoAttendance(
      tenantId,
      id,
      undefined,
      'A shift with attendance recorded against it cannot be deleted or replaced',
    );

    await this.prisma.workingSchedule.update({
      where: { id },
      data: { status: ScheduleStatus.DELETED },
    });
    return { message: 'Xóa lịch làm việc thành công', data: { id } };
  }

  /** Takes one person off a shift; removing the last person deletes it, since an empty schedule is nobody working. */
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
    await this.assertNoAttendance(
      tenantId,
      id,
      userId,
      'An employee with attendance recorded on this shift cannot be removed from it',
    );

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

  // ─── Assignment resolution ─────────────────────────────────────────────────

  /** Validates the people and templates, then works out the real instants for each row. */
  private async resolveAssignments(
    tenantId: string,
    assignments: ScheduleAssignmentDto[],
  ): Promise<ResolvedAssignment[]> {
    const userIds = [
      ...new Set(assignments.flatMap((assignment) => assignment.userId)),
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
        userIds: [...new Set(assignment.userId)],
        shiftTemplateId: assignment.shiftTemplateId,
        scheduleType: assignment.scheduleType ?? ScheduleType.NORMAL,
        workDate: workDateOf(assignment.workDate),
        startAt,
        endAt,
      };
    });
  }

  /** Everyone rostered has to be an active STAFF account in this tenant - what remains of the old check once `validateRoleHierarchy` is dropped. */
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

  /** Rows describing the same slot become one row with everyone on it. */
  private mergeBySlot(assignments: ResolvedAssignment[]): ResolvedAssignment[] {
    const bySlot = new Map<string, ResolvedAssignment>();
    for (const assignment of assignments) {
      const key = [
        assignment.scheduleType,
        assignment.shiftTemplateId,
        assignment.workDate.toISOString(),
        assignment.startAt.toISOString(),
        assignment.endAt.toISOString(),
      ].join('|');

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

  /** Adds to the schedule already on this slot, or creates it. */
  private async upsertSlot(
    tenantId: string,
    actorId: string,
    assignment: ResolvedAssignment,
  ): Promise<ScheduleRow> {
    const existing = await this.prisma.workingSchedule.findFirst({
      where: {
        tenantId,
        scheduleType: assignment.scheduleType,
        shiftTemplateId: assignment.shiftTemplateId,
        workDate: assignment.workDate,
        startAt: assignment.startAt,
        endAt: assignment.endAt,
        status: { in: LIVE_SCHEDULE_STATUSES },
      },
      include: { assignedUsers: { select: { userId: true } } },
    });

    if (!existing) {
      return this.prisma.workingSchedule.create({
        data: {
          tenantId,
          createdById: actorId,
          managedById: actorId,
          shiftTemplateId: assignment.shiftTemplateId,
          scheduleType: assignment.scheduleType,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
          status: ScheduleStatus.SCHEDULED,
          assignedUsers: {
            create: assignment.userIds.map((userId) => ({ userId })),
          },
        },
        include: SCHEDULE_INCLUDE,
      });
    }

    // `skipDuplicates` is the join table's equivalent of the old `$addToSet`: re-rostering somebody already on the shift is a no-op, not an error.
    const already = new Set(existing.assignedUsers.map((a) => a.userId));
    const toAdd = assignment.userIds.filter((id) => !already.has(id));
    return this.prisma.workingSchedule.update({
      where: { id: existing.id },
      data: {
        managedById: actorId,
        assignedUsers: {
          createMany: {
            data: toAdd.map((userId) => ({ userId })),
            skipDuplicates: true,
          },
        },
      },
      include: SCHEDULE_INCLUDE,
    });
  }

  /** Nobody may be on two overlapping shifts. The old service ran an O(n²) sweep plus a query per person; this is one query per assignment, and the in-batch case is covered because each is checked against what the loop has already saved. */
  private async assertNoOverlap(
    tenantId: string,
    assignment: ResolvedAssignment,
    excludeScheduleId?: string,
  ) {
    const clash = await this.prisma.workingSchedule.findFirst({
      where: {
        tenantId,
        status: { in: LIVE_SCHEDULE_STATUSES },
        ...(excludeScheduleId ? { id: { not: excludeScheduleId } } : {}),
        assignedUsers: { some: { userId: { in: assignment.userIds } } },
        startAt: { lt: assignment.endAt },
        endAt: { gt: assignment.startAt },
        // The same slot is a merge, not a clash - that is how adding a person to an existing shift works.
        NOT: {
          shiftTemplateId: assignment.shiftTemplateId,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
        },
      },
      include: { shiftTemplate: { select: { name: true } } },
    });

    if (clash) {
      throw new ConflictException({
        code: ErrorCode.SCHEDULE_OVERLAP,
        message: `Overlaps ${clash.shiftTemplate?.name ?? 'shift'} on ${localDateText(clash.workDate ?? assignment.workDate)}`,
      });
    }
  }

  private async assertNoAttendance(
    tenantId: string,
    scheduleId: string,
    userId: string | undefined,
    message: string,
  ) {
    const found = await this.prisma.attendance.findFirst({
      where: { tenantId, scheduleId, ...(userId ? { userId } : {}) },
      select: { id: true },
    });
    if (found)
      throw new ConflictException({
        code: ErrorCode.SCHEDULE_HAS_ATTENDANCE,
        message,
      });
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

  private buildWhere(
    tenantId: string,
    query: QueryWorkingScheduleDto,
  ): Prisma.WorkingScheduleWhereInput {
    const where: Prisma.WorkingScheduleWhereInput = {
      tenantId,
      status: query.status ?? { not: ScheduleStatus.DELETED },
    };
    if (query.scheduleType) where.scheduleType = query.scheduleType;

    // "Whose schedules" is a fact about the people on them, so it is one relation filter rather than the old fetch-ids-then-intersect-in-memory two-step.
    const assigned: Prisma.WorkingScheduleUserWhereInput = {};
    if (query.userId) assigned.userId = query.userId;
    if (query.branchId || query.warehouseId) {
      assigned.user = {
        tenantId,
        status: { not: UserStatus.DELETED },
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
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
        // Exclusive upper bound one day on, so `endDate` itself is included.
        const next = workDateOf(query.endDate);
        next.setUTCDate(next.getUTCDate() + 1);
        range.lt = next;
      }
      where.workDate = range;
    }

    return where;
  }

  // ─── Decoration ────────────────────────────────────────────────────────────

  /** Adds the two things a schedule row can't answer on its own: what kind of day it falls on, and how each person actually turned up. */
  private async decorate(
    tenantId: string,
    rows: ScheduleRow[],
    detail: boolean,
  ) {
    if (rows.length === 0) return [];

    const [holidayNames, attendances, graceMinutes] = await Promise.all([
      this.holidaysIn(tenantId, rows),
      this.attendancesFor(tenantId, rows),
      this.lateGraceMinutes(tenantId),
    ]);

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
        // Same nesting the `/users` responses use - a staff member's name is under `profile` on the wire wherever it appears.
        assignedUsers: row.assignedUsers.map((assigned) => ({
          ...withNestedProfile(assigned.user),
          attendance: this.attendanceSummary(
            attendances.get(`${row.id}:${assigned.userId}`) ?? null,
            row,
            graceMinutes,
            detail,
          ),
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

  private async attendancesFor(tenantId: string, rows: ScheduleRow[]) {
    const attendances = await this.prisma.attendance.findMany({
      where: { tenantId, scheduleId: { in: rows.map((row) => row.id) } },
    });
    return new Map(
      attendances.map((row) => [`${row.scheduleId}:${row.userId}`, row]),
    );
  }

  /** One tenant-wide setting; falls back to the old service's 15 when unset. */
  private async lateGraceMinutes(tenantId: string): Promise<number> {
    const setting = await this.prisma.payrollSetting.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      select: { lateGraceMinutes: true },
    });
    return setting?.lateGraceMinutes ?? DEFAULT_LATE_GRACE_MINUTES;
  }

  /** How one person's attendance looks against this shift. `workedMinutesInThisSchedule` is the overlap between the clock-in window and the shift, not the raw worked total: clocking in early and out late does not work more of this shift than it is long. */
  private attendanceSummary(
    attendance: AttendanceRow | null,
    schedule: ScheduleRow,
    graceMinutes: number,
    detail: boolean,
  ) {
    if (!attendance) {
      return {
        id: null,
        status: 'NOT_CHECKED_IN',
        actualCheckinAt: null,
        actualCheckoutAt: null,
        workedMinutesInThisSchedule: 0,
        lateMinutes: null,
      };
    }

    const base = {
      id: attendance.id,
      status: attendance.status ?? 'NOT_CHECKED_IN',
      actualCheckinAt: attendance.actualCheckinAt,
      actualCheckoutAt: attendance.actualCheckoutAt,
      workedMinutesInThisSchedule: attendance.actualCheckoutAt
        ? overlapMinutes(
            attendance.actualCheckinAt,
            attendance.actualCheckoutAt,
            schedule.startAt,
            schedule.endAt,
          )
        : 0,
      lateMinutes: lateMinutesOf(
        attendance.actualCheckinAt,
        schedule.startAt,
        schedule.scheduleType,
        graceMinutes,
      ),
    };

    if (!detail) return base;
    return {
      ...base,
      workedMinutes: attendance.workedMinutes,
      overtimeMinute: attendance.overtimeMinute,
      checkInLocation: {
        latitude: attendance.checkInLatitude,
        longitude: attendance.checkInLongitude,
        accuracy: attendance.checkInAccuracy,
        distance: attendance.checkInDistance,
        verificationStatus: attendance.checkInVerificationStatus,
      },
      checkOutLocation: {
        latitude: attendance.checkOutLatitude,
        longitude: attendance.checkOutLongitude,
        accuracy: attendance.checkOutAccuracy,
        distance: attendance.checkOutDistance,
        verificationStatus: attendance.checkOutVerificationStatus,
      },
    };
  }

  /** Shift template times go out as `HH:mm`, and the join rows flatten to their users. */
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
      assignedUsers: assignedUsers.map((assigned) => assigned.user),
    };
  }
}
