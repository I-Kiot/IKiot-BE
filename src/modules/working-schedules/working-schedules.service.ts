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
  localDateText,
  shiftInterval,
  workDateOf,
} from './schedule-time';
import {
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

const SCHEDULE_INCLUDE = {
  shiftTemplate: true,
  assignedUsers: { include: { user: { select: STAFF_SELECT } } },
} as const satisfies Prisma.WorkingScheduleInclude;

type ScheduleRow = Prisma.WorkingScheduleGetPayload<{
  include: typeof SCHEDULE_INCLUDE;
}>;

interface ResolvedAssignment {
  userIds: string[];
  shiftTemplateId: string;
  scheduleType: string;
  workDate: Date;
  startAt: Date;
  endAt: Date;
}

/**
 * Lịch làm việc là một ca trong một ngày có nhiều người; phân ca theo lô vì quản lý xếp cả tuần một lần.
 * Đã bỏ có chủ đích `deduplicateWorkingSchedules` (Postgres chặn trùng bằng partial unique index) và `validateRoleHierarchy` (các role đó không còn).
 */
@Injectable()
export class WorkingScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shiftTemplates: ShiftTemplateService,
    private readonly notifications: NotificationService,
  ) {}

  /** Các dòng rơi vào cùng một slot được gộp thành một lịch, không ghi hai lần; nhờ vậy thêm người vào ca đã có sẵn vẫn hoạt động. */
  async createBulk(
    tenantId: string,
    actorId: string,
    dto: BulkCreateWorkingScheduleDto,
  ) {
    const resolved = await this.resolveAssignments(tenantId, dto.schedules);
    const merged = this.mergeBySlot(resolved);
    // Kiểm tra cả lô trước khi ghi bất cứ gì, để một dòng trùng không để lại các dòng trước đó đã lưu dở.
    await this.assertNotAlreadyAssigned(tenantId, merged);

    const saved: ScheduleRow[] = [];
    for (const assignment of merged) {
      await this.assertNoOverlap(tenantId, assignment);
      saved.push(await this.upsertSlot(tenantId, actorId, assignment));
    }

    // Mỗi người nhận một thông báo, không theo từng dòng (xếp một tuần tạo nhiều lịch cho cùng một người). Bỏ qua người thực hiện.
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

  /** Trả `{ data: null }` thay vì 404 vì không có ca là kết quả bình thường (máy bán hàng hỏi lúc khởi động). Kèm `serverTime` để client không phải tin đồng hồ của mình. */
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

  /** Mọi người được xếp ca phải là tài khoản STAFF đang hoạt động trong tenant; đây là phần còn lại của kiểm tra cũ sau khi bỏ `validateRoleHierarchy`. */
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

    // Người đã có trong ca bị `assertNotAlreadyAssigned` từ chối từ trước (bug DEF-ST-08: trước đây là no-op trả 201).
    // Không `skipDuplicates`: hai request cùng phân một người đã qua kiểm tra thì khoá `@@id([scheduleId, userId])`
    // làm người chậm hơn nhận P2002 → 409, thay vì cả hai cùng báo thành công.
    const already = new Set(existing.assignedUsers.map((a) => a.userId));
    const toAdd = assignment.userIds.filter((id) => !already.has(id));
    return this.prisma.workingSchedule.update({
      where: { id: existing.id },
      data: {
        managedById: actorId,
        assignedUsers: {
          createMany: {
            data: toAdd.map((userId) => ({ userId })),
          },
        },
      },
      include: SCHEDULE_INCLUDE,
    });
  }

  /**
   * Từ chối phân lại một người vào đúng ca (cùng loại, ca mẫu, ngày, giờ) họ đã có. Một query cho cả lô:
   * tải mọi lịch còn sống của các slot trong lô, rồi đối chiếu người trong bộ nhớ.
   */
  private async assertNotAlreadyAssigned(
    tenantId: string,
    assignments: ResolvedAssignment[],
  ) {
    if (assignments.length === 0) return;
    const existing = await this.prisma.workingSchedule.findMany({
      where: {
        tenantId,
        status: { in: LIVE_SCHEDULE_STATUSES },
        OR: assignments.map((assignment) => ({
          scheduleType: assignment.scheduleType,
          shiftTemplateId: assignment.shiftTemplateId,
          workDate: assignment.workDate,
          startAt: assignment.startAt,
          endAt: assignment.endAt,
        })),
      },
      select: {
        scheduleType: true,
        shiftTemplateId: true,
        workDate: true,
        startAt: true,
        endAt: true,
        shiftTemplate: { select: { name: true } },
        assignedUsers: { select: { userId: true } },
      },
    });

    const duplicates: {
      userId: string;
      workDate: string;
      shiftName: string;
    }[] = [];
    for (const assignment of assignments) {
      const slot = existing.find(
        (row) =>
          row.scheduleType === assignment.scheduleType &&
          row.shiftTemplateId === assignment.shiftTemplateId &&
          row.workDate?.getTime() === assignment.workDate.getTime() &&
          row.startAt?.getTime() === assignment.startAt.getTime() &&
          row.endAt?.getTime() === assignment.endAt.getTime(),
      );
      if (!slot) continue;
      const onShift = new Set(slot.assignedUsers.map((a) => a.userId));
      for (const userId of assignment.userIds) {
        if (!onShift.has(userId)) continue;
        duplicates.push({
          userId,
          workDate: localDateText(assignment.workDate),
          shiftName: slot.shiftTemplate?.name ?? 'shift',
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

  /** Không ai được ở hai ca chồng nhau. Mỗi assignment một query; trường hợp trùng trong cùng batch được bắt vì dòng sau đối chiếu với dòng đã lưu trước đó. */
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
        // Cùng slot là gộp, không phải trùng - đó là cách thêm người vào ca đã có.
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

  // ─── Decoration ────────────────────────────────────────────────────────────

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
        assignedUsers: row.assignedUsers.map((assigned) =>
          withNestedProfile(withPosting(assigned.user)),
        ),
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
      assignedUsers: assignedUsers.map((assigned) =>
        withPosting(assigned.user),
      ),
    };
  }
}
