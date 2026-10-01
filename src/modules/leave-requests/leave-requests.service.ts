import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  narrowStaffScope,
  type StaffReadScope,
} from '../../common/utils/scope-filter';
import { NotificationService } from '../notifications/notifications.service';
import { LeaveRequestNotificationTemplates } from '../notifications/templates/leave-request.templates';
import { SystemRole } from '../../common/constants/system-role';
import {
  INACTIVE_USER_STATUSES,
  UserStatus,
} from '../../common/constants/user-status';
import { can } from '../../common/utils/permission';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import type { NotificationContent } from '../notifications/notification-content.type';
import { ScheduleStatus } from '../working-schedules/working-schedule.constants';
import { leaveDate, leaveDayCount, nextDay } from './leave-date';
import {
  DEFAULT_ANNUAL_LEAVE_DAYS,
  LeaveRequestStatus,
  LIVE_LEAVE_STATUSES,
} from './leave-request.constants';
import {
  CreateEmergencyLeaveRequestDto,
  CreateLeaveRequestDto,
  PreviewHandoverDto,
  QueryLeavePerDayDto,
  QueryLeaveRequestDto,
  ReviewLeaveRequestDto,
} from './dto/leave-request.dto';
import type { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const REQUESTER_SELECT = {
  id: true,
  email: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
  branchId: true,
  warehouseId: true,
  branch: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
} as const;

const REQUEST_INCLUDE = {
  user: { select: REQUESTER_SELECT },
  approvedBy: {
    select: {
      id: true,
      profileFirstName: true,
      profileLastName: true,
      phoneNumber: true,
    },
  },
  handoverToUser: {
    select: { id: true, profileFirstName: true, profileLastName: true },
  },
  handoverSchedules: { select: { scheduleId: true } },
} as const satisfies Prisma.LeaveRequestInclude;

type RequestRow = Prisma.LeaveRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;

/** Leave requests. Two things make this more than CRUD: approving spends `User.leaveBalanceRemainingDays` inside the transaction (conditionally, so two approvals can't overdraw it), and a supervisor going on leave hands their shifts in the window to `handoverToUserId`. "Manager" is answered by asking whether they actually manage shifts in the window, which is more precise than the old role check. `deleteLeaveRequest` is not ported - no route reached it, and it undid neither the balance nor the handover. */
@Injectable()
export class LeaveRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async findAll(user: AuthUser, query: QueryLeaveRequestDto) {
    const tenantId = this.tenantOf(user);
    const where = this.buildWhere(tenantId, query, this.readScope(user));

    const [rows, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findMine(user: AuthUser, query: QueryLeaveRequestDto) {
    const tenantId = this.tenantOf(user);
    const where = this.buildWhere(tenantId, query, { userId: user.userId });

    const [rows, total] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.leaveRequest.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** The caller's leave expanded to one entry per calendar day, newest first - what a calendar view needs. */
  async findMinePerDay(user: AuthUser, query: QueryLeavePerDayDto) {
    const tenantId = this.tenantOf(user);
    const from = query.startDate ? leaveDate(query.startDate) : null;
    const to = query.endDate ? leaveDate(query.endDate) : null;

    const requests = await this.prisma.leaveRequest.findMany({
      where: {
        tenantId,
        userId: user.userId,
        ...(query.status ? { status: query.status } : {}),
        ...(to ? { startDate: { lte: to } } : {}),
        ...(from ? { endDate: { gte: from } } : {}),
      },
      include: REQUEST_INCLUDE,
    });

    const days: (ReturnType<typeof this.toResponse> & { date: Date })[] = [];
    for (const request of requests) {
      if (!request.startDate || !request.endDate) continue;
      const shaped = this.toResponse(request);
      for (
        let day = leaveDate(request.startDate);
        day <= leaveDate(request.endDate);
        day = nextDay(day)
      ) {
        if (from && day < from) continue;
        if (to && day > to) continue;
        days.push({ ...shaped, date: new Date(day) });
      }
    }

    days.sort((left, right) => right.date.getTime() - left.date.getTime());
    return days;
  }

  async findOne(user: AuthUser, id: string) {
    const request = await this.prisma.leaveRequest.findFirst({
      where: { id, tenantId: this.tenantOf(user) },
      include: REQUEST_INCLUDE,
    });
    if (!request) {
      throw new NotFoundException({
        code: ErrorCode.LEAVE_REQUEST_NOT_FOUND,
        message: 'Leave request not found',
      });
    }
    this.assertCanRead(user, request.user);
    return this.toResponse(request);
  }

  /** The caller's annual allowance and what is left of it, defaulting to the statutory 12 days when the balance was never set. */
  async balanceOf(user: AuthUser) {
    const tenantId = this.tenantOf(user);
    const staff = await this.prisma.user.findFirst({
      where: {
        id: user.userId,
        tenantId,
        status: { not: UserStatus.DELETED },
      },
      select: { leaveBalanceAnnualDays: true, leaveBalanceRemainingDays: true },
    });
    if (!staff)
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_FOUND,
        message: 'Employee not found',
      });

    const annualLeaveDays =
      staff.leaveBalanceAnnualDays ?? DEFAULT_ANNUAL_LEAVE_DAYS;
    const remainingDays = staff.leaveBalanceRemainingDays ?? annualLeaveDays;
    return {
      annualLeaveDays,
      remainingDays,
      usedDays: annualLeaveDays - remainingDays,
    };
  }

  /** Which shifts a leave window would leave without a supervisor. Asking the database directly gives the same answer the old role check did for managers, and a correct one for anyone it would have missed. */
  async previewHandover(user: AuthUser, dto: PreviewHandoverDto) {
    const tenantId = this.tenantOf(user);
    const { from, toExclusive } = this.leaveWindow(dto.startDate, dto.endDate);

    const affected = await this.prisma.workingSchedule.findMany({
      where: this.managedInWindow(tenantId, user.userId, from, toExclusive),
      include: {
        shiftTemplate: true,
        assignedUsers: {
          select: {
            user: {
              select: {
                id: true,
                phoneNumber: true,
                profileFirstName: true,
                profileLastName: true,
              },
            },
          },
        },
      },
      orderBy: [{ workDate: 'asc' }, { startAt: 'asc' }],
    });

    return {
      requiresHandover: affected.length > 0,
      count: affected.length,
      affectedSchedules: affected,
    };
  }

  // ─── Filing ────────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateLeaveRequestDto) {
    return this.file(user, user.userId, dto);
  }

  /** A manager filing on somebody else's behalf. The old role check is gone; the same-location half stays, because "you may file for people you work with" is the part that still means something. */
  async createEmergency(user: AuthUser, dto: CreateEmergencyLeaveRequestDto) {
    const tenantId = this.tenantOf(user);
    const target = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId, status: { not: UserStatus.DELETED } },
      select: { id: true, branchId: true, warehouseId: true },
    });
    if (!target)
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_FOUND,
        message: 'Employee not found',
      });

    if (
      user.systemRole !== SystemRole.TENANT_OWNER &&
      user.systemRole !== SystemRole.ADMIN &&
      !this.sameWorkplace(user, target)
    ) {
      throw new ForbiddenException({
        code: ErrorCode.LEAVE_EMERGENCY_LOCATION_DENIED,
        message:
          'You can only file a leave request for an employee at your own location',
      });
    }

    return this.file(user, dto.userId, dto);
  }

  /** The shared body of both filing routes. */
  private async file(
    actor: AuthUser,
    requesterId: string,
    dto: CreateLeaveRequestDto,
  ) {
    const tenantId = this.tenantOf(actor);
    const { from, to, toExclusive } = this.leaveWindow(
      dto.startDate,
      dto.endDate,
    );

    await this.assertNoOverlap(tenantId, requesterId, from, to);

    // Which of the requester's shifts the leave would strand - that, not anyone's role, is what decides whether a handover is needed.
    const affected = await this.prisma.workingSchedule.findMany({
      where: this.managedInWindow(tenantId, requesterId, from, toExclusive),
      select: { id: true },
    });

    if (affected.length === 0 && dto.handoverToUserId) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_NO_HANDOVER_NEEDED,
        message: 'There is no shift to hand over in this period',
      });
    }
    if (affected.length > 0) {
      await this.assertHandoverTargetValid(
        tenantId,
        requesterId,
        dto.handoverToUserId,
      );
    }

    const created = await this.prisma.leaveRequest.create({
      data: {
        tenantId,
        userId: requesterId,
        startDate: from,
        endDate: to,
        reason: dto.reason,
        status: LeaveRequestStatus.PENDING,
        handoverToUserId: affected.length > 0 ? dto.handoverToUserId : null,
        handoverSchedules: {
          create: affected.map((schedule) => ({ scheduleId: schedule.id })),
        },
      },
      include: REQUEST_INCLUDE,
    });

    // Outside the write: a failed notification must not lose the request, and notify() never throws.
    await this.notifyApprovers(tenantId, requesterId, (name) =>
      LeaveRequestNotificationTemplates.created(name, created.id),
    );

    return {
      message: 'Tạo yêu cầu nghỉ phép thành công',
      data: this.toResponse(created),
      handover: {
        required: affected.length > 0,
        reassignedSchedules: 0,
        handoverToUserId: created.handoverToUserId,
      },
    };
  }

  // ─── Review ────────────────────────────────────────────────────────────────

  /** Approving or rejecting. On approval the leave balance moves inside the same transaction as the status change and the handover - spending the days but failing to reassign the shifts would leave the shop uncovered and the employee short. */
  async review(
    user: AuthUser,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    dto: ReviewLeaveRequestDto,
  ) {
    const tenantId = this.tenantOf(user);

    if (decision === LeaveRequestStatus.REJECTED && !dto.reviewNote) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_REVIEW_NOTE_REQUIRED,
        message: 'A review note is required when rejecting a leave request',
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.leaveRequest.findFirst({
        where: { id, tenantId },
        include: {
          user: { select: { id: true, branchId: true, warehouseId: true } },
          handoverSchedules: { select: { scheduleId: true } },
        },
      });
      if (!current) {
        throw new NotFoundException({
          code: ErrorCode.LEAVE_REQUEST_NOT_FOUND,
          message: 'Leave request not found',
        });
      }

      // Never your own, whatever your permissions - the whole point of an approval is that somebody else looked at it.
      if (current.userId === user.userId) {
        throw new ForbiddenException({
          code: ErrorCode.LEAVE_SELF_REVIEW_DENIED,
          message: 'You cannot approve or reject your own leave request',
        });
      }
      this.assertCanRead(user, current.user);

      if (current.status !== LeaveRequestStatus.PENDING) {
        throw new ConflictException({
          code: ErrorCode.LEAVE_NOT_PENDING,
          message: 'Only a pending request can be approved',
        });
      }

      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;

      if (decision === LeaveRequestStatus.APPROVED) {
        if (
          dto.paidLeaveDays === undefined ||
          dto.unpaidLeaveDays === undefined
        ) {
          throw new BadRequestException({
            code: ErrorCode.LEAVE_DAY_SPLIT_REQUIRED,
            message: 'Paid and unpaid leave days are required on approval',
          });
        }
        paidLeaveDays = dto.paidLeaveDays;
        unpaidLeaveDays = dto.unpaidLeaveDays;

        const total = paidLeaveDays + unpaidLeaveDays;
        if (total <= 0) {
          throw new BadRequestException({
            code: ErrorCode.LEAVE_DAY_SPLIT_INVALID,
            message:
              'The total number of approved leave days must be greater than 0',
          });
        }
        const requested = leaveDayCount(current.startDate!, current.endDate!);
        if (total > requested) {
          throw new BadRequestException({
            code: ErrorCode.LEAVE_DAY_SPLIT_EXCEEDS_REQUEST,
            message:
              'Paid plus unpaid leave days cannot exceed the number of days requested',
          });
        }

        if (paidLeaveDays > 0) {
          await this.spendLeaveBalance(
            tx,
            tenantId,
            current.userId,
            paidLeaveDays,
          );
        }

        // Move the shifts; the handover target was validated when the request was filed and is re-checked here because the roster may have changed.
        const scheduleIds = current.handoverSchedules.map((h) => h.scheduleId);
        if (scheduleIds.length > 0) {
          await this.assertHandoverTargetValid(
            tenantId,
            current.userId,
            current.handoverToUserId,
          );
          await tx.workingSchedule.updateMany({
            where: {
              id: { in: scheduleIds },
              tenantId,
              managedById: current.userId,
              status: ScheduleStatus.SCHEDULED,
            },
            data: { managedById: current.handoverToUserId },
          });
        }
      }

      return tx.leaveRequest.update({
        where: { id },
        data: {
          status: decision,
          approvedById: user.userId,
          reviewNote: dto.reviewNote,
          ...(decision === LeaveRequestStatus.APPROVED
            ? { paidLeaveDays, unpaidLeaveDays }
            : {}),
        },
        include: REQUEST_INCLUDE,
      });
    });

    await this.notifications.notify({
      tenantId,
      recipientIds: [updated.userId],
      referenceId: updated.id,
      ...(decision === LeaveRequestStatus.APPROVED
        ? LeaveRequestNotificationTemplates.approved(updated.id)
        : LeaveRequestNotificationTemplates.rejected(
            updated.id,
            updated.reviewNote,
          )),
    });

    return this.toResponse(updated);
  }

  /** Withdrawing your own request, refused once the leave has started. Cancelling undoes both effects of the approval: the balance goes back, and the shifts go back to the person who filed the leave. */
  async cancel(user: AuthUser, id: string) {
    const tenantId = this.tenantOf(user);

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const current = await tx.leaveRequest.findFirst({
        where: { id, tenantId },
        include: { handoverSchedules: { select: { scheduleId: true } } },
      });
      if (!current) {
        throw new NotFoundException({
          code: ErrorCode.LEAVE_REQUEST_NOT_FOUND,
          message: 'Leave request not found',
        });
      }
      if (current.userId !== user.userId) {
        throw new ForbiddenException({
          code: ErrorCode.LEAVE_CANCEL_NOT_OWNER,
          message: 'You can only cancel your own leave request',
        });
      }
      if (!LIVE_LEAVE_STATUSES.includes(current.status as never)) {
        throw new BadRequestException({
          code: ErrorCode.LEAVE_CANCEL_STATUS_INVALID,
          message: 'Only a pending or approved request can be cancelled',
        });
      }

      const today = leaveDate(new Date());
      if (current.startDate && leaveDate(current.startDate) <= today) {
        throw new BadRequestException({
          code: ErrorCode.LEAVE_CANCEL_ALREADY_STARTED,
          message:
            'A leave request cannot be cancelled once the leave has started',
        });
      }

      const paid = Number(current.paidLeaveDays);
      if (current.status === LeaveRequestStatus.APPROVED && paid > 0) {
        await tx.user.update({
          where: { id: current.userId },
          data: { leaveBalanceRemainingDays: { increment: paid } },
        });
      }

      const scheduleIds = current.handoverSchedules.map((h) => h.scheduleId);
      if (current.handoverToUserId && scheduleIds.length > 0) {
        // Back to the person who went on leave, not to nobody: iKiotMS-BE set `managedBy: null` here, which left those shifts with no supervisor at all.
        await tx.workingSchedule.updateMany({
          where: {
            id: { in: scheduleIds },
            tenantId,
            managedById: current.handoverToUserId,
            status: ScheduleStatus.SCHEDULED,
          },
          data: { managedById: current.userId },
        });
      }

      return tx.leaveRequest.update({
        where: { id },
        data: { status: LeaveRequestStatus.CANCELLED },
        include: REQUEST_INCLUDE,
      });
    });

    // The approvers need to know, especially for an approved request - the roster may have been rearranged around it.
    await this.notifyApprovers(tenantId, cancelled.userId, (name) =>
      LeaveRequestNotificationTemplates.cancelled(name, cancelled.id),
    );

    return this.toResponse(cancelled);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Validates and normalises a leave window to whole UTC days. */
  private leaveWindow(startDate: string, endDate: string) {
    const from = leaveDate(startDate);
    const to = leaveDate(endDate);
    if (from > to) {
      throw new BadRequestException({
        code: ErrorCode.DATE_RANGE_INVALID,
        message: 'The end date cannot be before the start date',
      });
    }
    return { from, to, toExclusive: nextDay(to) };
  }

  /** Shifts this person supervises inside a window - the handover set. */
  private managedInWindow(
    tenantId: string,
    userId: string,
    from: Date,
    toExclusive: Date,
  ): Prisma.WorkingScheduleWhereInput {
    return {
      tenantId,
      managedById: userId,
      status: ScheduleStatus.SCHEDULED,
      workDate: { gte: from, lt: toExclusive },
    };
  }

  /** One person can't be on leave twice over the same days. */
  private async assertNoOverlap(
    tenantId: string,
    userId: string,
    from: Date,
    to: Date,
    exceptId?: string,
  ) {
    const overlap = await this.prisma.leaveRequest.findFirst({
      where: {
        tenantId,
        userId,
        status: { in: LIVE_LEAVE_STATUSES },
        startDate: { lte: to },
        endDate: { gte: from },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    });
    if (overlap) {
      throw new ConflictException({
        code: ErrorCode.LEAVE_OVERLAPPING_REQUEST,
        message: 'An overlapping leave request already exists for this period',
      });
    }
  }

  /** The person taking over has to exist, be usable, not be the requester, and work in the same place. */
  private async assertHandoverTargetValid(
    tenantId: string,
    requesterId: string,
    handoverToUserId: string | null | undefined,
  ) {
    if (!handoverToUserId) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_HANDOVER_REQUIRED,
        message:
          'A handover recipient is required because there are shifts during the leave',
      });
    }
    if (handoverToUserId === requesterId) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_HANDOVER_SELF,
        message: 'Shifts cannot be handed over to yourself',
      });
    }

    const [requester, target] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: requesterId, tenantId },
        select: { branchId: true, warehouseId: true },
      }),
      this.prisma.user.findFirst({
        where: { id: handoverToUserId, tenantId },
        select: { id: true, status: true, branchId: true, warehouseId: true },
      }),
    ]);
    if (!target || INACTIVE_USER_STATUSES.has(target.status)) {
      throw new NotFoundException({
        code: ErrorCode.LEAVE_HANDOVER_TARGET_NOT_FOUND,
        message:
          'The handover recipient was not found, or the account is not active',
      });
    }
    if (
      requester &&
      (requester.branchId !== target.branchId ||
        requester.warehouseId !== target.warehouseId)
    ) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_HANDOVER_TARGET_LOCATION,
        message: 'The handover recipient must work at the same location',
      });
    }
  }

  /** Takes paid days off the allowance with a conditional `updateMany`: two approvals landing at once would both read the same balance, and matching nothing is the answer to "was there enough". */
  private async spendLeaveBalance(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    days: number,
  ) {
    const staff = await tx.user.findFirst({
      where: { id: userId, tenantId, status: { not: UserStatus.DELETED } },
      select: { leaveBalanceAnnualDays: true, leaveBalanceRemainingDays: true },
    });
    if (!staff)
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_FOUND,
        message: 'Employee not found',
      });

    // Fill in the default allowance the first time it is needed, as the old service did.
    if (
      staff.leaveBalanceAnnualDays === null ||
      staff.leaveBalanceRemainingDays === null
    ) {
      const annual = staff.leaveBalanceAnnualDays ?? DEFAULT_ANNUAL_LEAVE_DAYS;
      await tx.user.update({
        where: { id: userId },
        data: {
          leaveBalanceAnnualDays: annual,
          leaveBalanceRemainingDays: staff.leaveBalanceRemainingDays ?? annual,
        },
      });
    }

    const spent = await tx.user.updateMany({
      where: { id: userId, tenantId, leaveBalanceRemainingDays: { gte: days } },
      data: { leaveBalanceRemainingDays: { decrement: days } },
    });
    if (spent.count === 0) {
      throw new BadRequestException({
        code: ErrorCode.LEAVE_BALANCE_INSUFFICIENT,
        message: 'Not enough paid leave days remaining',
      });
    }
  }

  /** Tells whoever signs off on this person's leave; the copy is a callback because it needs the requester's display name, and looking that up is this method's job. */
  private async notifyApprovers(
    tenantId: string,
    requesterId: string,
    content: (requesterName: string) => NotificationContent,
  ) {
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { branchId: true, warehouseId: true },
    });
    const [approvers, name] = await Promise.all([
      this.notifications.approversOf({
        userId: requesterId,
        tenantId,
        branchId: requester?.branchId ?? null,
        warehouseId: requester?.warehouseId ?? null,
      }),
      this.notifications.displayName(requesterId),
    ]);

    await this.notifications.notify({
      tenantId,
      recipientIds: approvers,
      ...content(name),
    });
  }

  // ─── Access ────────────────────────────────────────────────────────────────

  /** Your own always; `leaveRequests:read_all` widens it to your own location. */
  private readScope(user: AuthUser): StaffReadScope {
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    ) {
      return {};
    }
    if (!can(user, 'leaveRequests', 'read_all')) {
      return { userId: user.userId };
    }
    if (user.branchId) return { branchId: user.branchId };
    if (user.warehouseId) return { warehouseId: user.warehouseId };
    return { userId: user.userId };
  }

  private assertCanRead(
    user: AuthUser,
    target: { id: string; branchId: string | null; warehouseId: string | null },
  ) {
    if (target.id === user.userId) return;
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    ) {
      return;
    }
    if (this.sameWorkplace(user, target)) return;
    throw new ForbiddenException({
      code: ErrorCode.LEAVE_READ_DENIED,
      message: 'You are not allowed to view this leave request',
    });
  }

  private sameWorkplace(
    user: AuthUser,
    target: { branchId: string | null; warehouseId: string | null },
  ): boolean {
    if (user.branchId) return target.branchId === user.branchId;
    if (user.warehouseId) return target.warehouseId === user.warehouseId;
    return false;
  }

  // ─── Filters ───────────────────────────────────────────────────────────────

  private buildWhere(
    tenantId: string,
    query: QueryLeaveRequestDto,
    scope: StaffReadScope,
  ): Prisma.LeaveRequestWhereInput {
    const where: Prisma.LeaveRequestWhereInput = { tenantId };
    // Every client filter narrows the server-derived scope and none may replace it.
    const scoped = narrowStaffScope(scope, query, {
      own: 'You can only view your own leave requests',
      location: 'You can only view leave requests at your own location',
    });
    if (scoped.userId) where.userId = scoped.userId;
    if (scoped.branchId || scoped.warehouseId) {
      where.user = {
        ...(scoped.branchId ? { branchId: scoped.branchId } : {}),
        ...(scoped.warehouseId ? { warehouseId: scoped.warehouseId } : {}),
      };
    }
    if (query.status) where.status = query.status;

    // Filters on when the leave begins, as the old filter did - "who is starting leave this month" rather than "whose leave touches this month".
    if (query.startDate || query.endDate) {
      where.startDate = {
        ...(query.startDate ? { gte: leaveDate(query.startDate) } : {}),
        ...(query.endDate ? { lte: leaveDate(query.endDate) } : {}),
      };
    }

    if (query.keyword) {
      const match = { contains: query.keyword, mode: 'insensitive' } as const;
      where.OR = [
        { reason: match },
        { user: { profileFirstName: match } },
        { user: { profileLastName: match } },
      ];
    }

    return where;
  }

  private toResponse(row: RequestRow) {
    const { paidLeaveDays, unpaidLeaveDays, handoverSchedules, ...rest } = row;
    return {
      ...rest,
      paidLeaveDays: Number(paidLeaveDays),
      unpaidLeaveDays: Number(unpaidLeaveDays),
      handoverScheduleIds: handoverSchedules.map((h) => h.scheduleId),
    };
  }
}
