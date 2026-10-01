import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  narrowStaffScope,
  type StaffReadScope,
} from '../../common/utils/scope-filter';
import { SystemRole } from '../../common/constants/system-role';
import { can } from '../../common/utils/permission';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import { lateMinutesOf } from '../working-schedules/schedule-time';
import {
  DEFAULT_LATE_GRACE_MINUTES,
  ScheduleStatus,
} from '../working-schedules/working-schedule.constants';
import { verifyWithinFence } from './geo-fence';
import type { GeoPoint, GeoVerdict } from './geo-fence';
import {
  ALLOWED_EARLY_CHECKIN_MINUTES,
  ATTENDANCE_LOCKING_PERIOD_STATUSES,
  AttendanceStatus,
  OPEN_PERIOD_STATUSES,
} from './attendance.constants';
import {
  CheckInDto,
  CheckOutDto,
  CreateManualAttendanceDto,
  ManualCheckoutDto,
  QueryAttendanceDto,
} from './dto/attendance.dto';
import type { Attendance, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const SCHEDULE_INCLUDE = {
  select: {
    id: true,
    workDate: true,
    startAt: true,
    endAt: true,
    status: true,
    scheduleType: true,
    shiftTemplate: {
      select: { id: true, name: true, startTime: true, endTime: true },
    },
  },
} as const;

const USER_INCLUDE = {
  select: {
    id: true,
    phoneNumber: true,
    email: true,
    profileFirstName: true,
    profileLastName: true,
    branchId: true,
    warehouseId: true,
    branch: { select: { id: true, name: true, address: true } },
    warehouse: { select: { id: true, name: true, address: true } },
  },
} as const;

/** Clocking in and out - the old `TakeAttendanceService` + `ManageAttendanceService`, merged. An attendance row is a payroll input: geofenced, tied to a rostered shift, every manual change signed, and frozen once its payroll period is reviewed. */
@Injectable()
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Clocking in and out ───────────────────────────────────────────────────

  /** Clocking in against a rostered shift. `workDate` is copied from the schedule, never derived from the check-in instant - an overnight shift would land on the wrong calendar day, and payroll groups by that date. */
  async checkIn(user: AuthUser, dto: CheckInDto) {
    const tenantId = this.tenantOf(user);
    const checkinAt = new Date(dto.actualCheckinAt);

    const schedule = await this.prisma.workingSchedule.findFirst({
      where: {
        id: dto.scheduleId,
        tenantId,
        status: ScheduleStatus.SCHEDULED,
        assignedUsers: { some: { userId: user.userId } },
      },
      select: {
        id: true,
        workDate: true,
        startAt: true,
        endAt: true,
        scheduleType: true,
      },
    });
    if (!schedule) {
      throw new NotFoundException({
        code: ErrorCode.ATTENDANCE_SCHEDULE_NOT_FOUND,
        message: 'No shift found to check in against',
      });
    }

    this.assertWithinCheckInWindow(checkinAt, schedule);

    const existing = await this.prisma.attendance.findUnique({
      where: {
        userId_scheduleId: { userId: user.userId, scheduleId: schedule.id },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: ErrorCode.ATTENDANCE_ALREADY_EXISTS,
        message: 'This employee has already checked in for this shift',
      });
    }

    const geo = await this.verifyAtWorkplace(tenantId, user.userId, {
      latitude: dto.checkInLocation.latitude,
      longitude: dto.checkInLocation.longitude,
      accuracy: dto.checkInLocation.accuracy,
    });

    // Lateness is computed and stored here; iKiotMS-BE never wrote `lateMinutes`, which made `?lateOnly=true` a filter that could never match.
    const graceMinutes = await this.lateGraceMinutes(tenantId);
    const lateMinutes = lateMinutesOf(
      checkinAt,
      schedule.startAt,
      schedule.scheduleType,
      graceMinutes,
    );

    try {
      const attendance = await this.prisma.attendance.create({
        data: {
          tenantId,
          userId: user.userId,
          scheduleId: schedule.id,
          workDate: schedule.workDate!,
          actualCheckinAt: checkinAt,
          lateMinutes,
          checkInLatitude: dto.checkInLocation.latitude,
          checkInLongitude: dto.checkInLocation.longitude,
          checkInAccuracy: dto.checkInLocation.accuracy,
          checkInDistance: geo.distance,
          checkInVerificationStatus: geo.verificationStatus,
          status: AttendanceStatus.CHECKED_IN,
        },
      });
      return {
        message: 'Check-in thành công',
        data: { attendance: this.toResponse(attendance), geo },
      };
    } catch (error) {
      // `@@unique([userId, scheduleId])` is the real guard; the read above only gives a friendlier message.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: ErrorCode.ATTENDANCE_ALREADY_EXISTS,
          message: 'This employee has already checked in for this shift',
        });
      }
      throw error;
    }
  }

  async checkOut(user: AuthUser, dto: CheckOutDto) {
    const tenantId = this.tenantOf(user);
    const checkoutAt = new Date(dto.actualCheckoutAt);

    const attendance = await this.prisma.attendance.findFirst({
      where: { id: dto.attendanceId, tenantId, userId: user.userId },
    });
    if (!attendance)
      throw new NotFoundException({
        code: ErrorCode.ATTENDANCE_NOT_FOUND,
        message: 'Attendance record not found',
      });
    if (attendance.status !== AttendanceStatus.CHECKED_IN) {
      throw new BadRequestException({
        code: ErrorCode.ATTENDANCE_NOT_CHECKED_IN,
        message: 'Attendance record is not in the CHECKED_IN state',
      });
    }

    const geo = await this.verifyAtWorkplace(tenantId, user.userId, {
      latitude: dto.checkOutLocation.latitude,
      longitude: dto.checkOutLocation.longitude,
      accuracy: dto.checkOutLocation.accuracy,
    });

    if (attendance.actualCheckinAt && checkoutAt < attendance.actualCheckinAt) {
      throw new HttpException(
        {
          code: ErrorCode.ATTENDANCE_CHECKOUT_BEFORE_CHECKIN,
          message: 'Check-out time cannot be before check-in time',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const updated = await this.prisma.attendance.update({
      where: { id: attendance.id },
      data: {
        actualCheckoutAt: checkoutAt,
        workedMinutes: this.minutesBetween(
          attendance.actualCheckinAt,
          checkoutAt,
        ),
        checkOutLatitude: dto.checkOutLocation.latitude,
        checkOutLongitude: dto.checkOutLocation.longitude,
        checkOutAccuracy: dto.checkOutLocation.accuracy,
        checkOutDistance: geo.distance,
        checkOutVerificationStatus: geo.verificationStatus,
        status: AttendanceStatus.CHECKED_OUT,
      },
    });

    return {
      message: 'Check-out thành công',
      data: { attendance: this.toResponse(updated), geo },
    };
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async findAll(user: AuthUser, query: QueryAttendanceDto) {
    const tenantId = this.tenantOf(user);
    const where = this.buildWhere(tenantId, query, this.readScope(user));

    const [rows, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        include: { schedule: SCHEDULE_INCLUDE },
        orderBy: { workDate: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.attendance.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  /** `GET /attendances/me` - always just the caller, whatever else they may read. */
  async findMine(user: AuthUser, query: QueryAttendanceDto) {
    const tenantId = this.tenantOf(user);
    const where = this.buildWhere(tenantId, query, { userId: user.userId });

    const [rows, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where,
        include: { schedule: SCHEDULE_INCLUDE },
        orderBy: { workDate: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.attendance.count({ where }),
    ]);

    return paginate(
      rows.map((row) => this.toResponse(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const attendance = await this.prisma.attendance.findFirst({
      where: { id, tenantId: this.tenantOf(user) },
      include: { schedule: SCHEDULE_INCLUDE, user: USER_INCLUDE },
    });
    if (!attendance)
      throw new NotFoundException({
        code: ErrorCode.ATTENDANCE_NOT_FOUND,
        message: 'Attendance record not found',
      });

    this.assertCanRead(user, attendance.user);
    return this.toResponse(attendance);
  }

  // ─── Manual correction ─────────────────────────────────────────────────────

  /** Closes a shift somebody clocked into and never clocked out of. */
  async manualCheckout(user: AuthUser, id: string, dto: ManualCheckoutDto) {
    const tenantId = this.tenantOf(user);
    const attendance = await this.prisma.attendance.findFirst({
      where: { id, tenantId },
      include: {
        user: { select: { id: true, branchId: true, warehouseId: true } },
      },
    });
    if (!attendance)
      throw new NotFoundException({
        code: ErrorCode.ATTENDANCE_NOT_FOUND,
        message: 'Attendance record not found',
      });

    this.assertCanCorrect(user, attendance.user);

    if (
      attendance.status !== AttendanceStatus.CHECKED_IN ||
      !attendance.actualCheckinAt
    ) {
      throw new ConflictException({
        code: ErrorCode.ATTENDANCE_NOT_CHECKED_IN,
        message: 'Only a CHECKED_IN record can have its check-out filled in',
      });
    }

    const checkoutAt = new Date(dto.actualCheckoutAt);
    if (checkoutAt <= attendance.actualCheckinAt) {
      throw new HttpException(
        {
          code: ErrorCode.ATTENDANCE_CHECKOUT_BEFORE_CHECKIN,
          message: 'Check-out time must be after check-in time',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (checkoutAt > new Date()) {
      throw new HttpException(
        {
          code: ErrorCode.ATTENDANCE_CHECKOUT_IN_FUTURE,
          message: 'Check-out time cannot be in the future',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.assertPayrollPeriodOpen(tenantId, attendance.workDate);

    const updated = await this.prisma.attendance.update({
      where: { id },
      data: {
        actualCheckoutAt: checkoutAt,
        workedMinutes: this.minutesBetween(
          attendance.actualCheckinAt,
          checkoutAt,
        ),
        status: AttendanceStatus.CHECKED_OUT,
        manuallyEditedById: user.userId,
        manuallyEditedAt: new Date(),
        manualEditReason: dto.reason,
      },
    });
    return this.toResponse(updated);
  }

  /** Writes an attendance record from scratch - somebody worked and the app never recorded it, or they didn't turn up at all. */
  async createManual(user: AuthUser, dto: CreateManualAttendanceDto) {
    const tenantId = this.tenantOf(user);

    const [schedule, target] = await Promise.all([
      this.prisma.workingSchedule.findFirst({
        where: {
          id: dto.scheduleId,
          tenantId,
          status: {
            in: [ScheduleStatus.SCHEDULED, ScheduleStatus.COMPLETED],
          },
          assignedUsers: { some: { userId: dto.userId } },
        },
        select: { id: true, workDate: true, startAt: true, endAt: true },
      }),
      this.prisma.user.findFirst({
        where: { id: dto.userId, tenantId },
        select: { id: true, branchId: true, warehouseId: true },
      }),
    ]);
    if (!schedule || !target) {
      throw new NotFoundException({
        code: ErrorCode.ATTENDANCE_SCHEDULE_NOT_FOUND,
        message: 'No shift found for this employee',
      });
    }

    this.assertCanCorrect(user, target);
    await this.assertPayrollPeriodOpen(tenantId, schedule.workDate!);

    const now = new Date();
    const checkinAt = dto.actualCheckinAt
      ? new Date(dto.actualCheckinAt)
      : null;
    const checkoutAt = dto.actualCheckoutAt
      ? new Date(dto.actualCheckoutAt)
      : null;

    if (dto.status === AttendanceStatus.ABSENT) {
      // You cannot mark someone absent from a shift they could still turn up to.
      if (!schedule.endAt || schedule.endAt > now) {
        throw new HttpException(
          {
            code: ErrorCode.ATTENDANCE_SHIFT_NOT_ENDED,
            message:
              'An absence can only be recorded after the shift has ended',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    } else {
      if (!checkinAt) {
        throw new BadRequestException({
          code: ErrorCode.ATTENDANCE_CHECKIN_REQUIRED,
          message: 'Check-in time is missing',
        });
      }
      const earliest = new Date(
        (schedule.startAt?.getTime() ?? 0) -
          ALLOWED_EARLY_CHECKIN_MINUTES * 60_000,
      );
      if (checkinAt < earliest) {
        throw new HttpException(
          {
            code: ErrorCode.ATTENDANCE_CHECKIN_TOO_EARLY,
            message: 'Check-in time is earlier than this shift allows',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (checkinAt > now) {
        throw new HttpException(
          {
            code: ErrorCode.ATTENDANCE_CHECKIN_IN_FUTURE,
            message: 'Check-in time cannot be in the future',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      if (dto.status === AttendanceStatus.CHECKED_OUT) {
        if (!checkoutAt)
          throw new BadRequestException({
            code: ErrorCode.ATTENDANCE_CHECKOUT_REQUIRED,
            message: 'Check-out time is missing',
          });
        if (checkoutAt <= checkinAt || checkoutAt > now) {
          throw new HttpException(
            {
              code: ErrorCode.ATTENDANCE_CHECKOUT_INVALID,
              message:
                'Check-out time must be after check-in and cannot be in the future',
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
      }
    }

    const isAbsent = dto.status === AttendanceStatus.ABSENT;
    const isCheckedOut = dto.status === AttendanceStatus.CHECKED_OUT;

    try {
      const attendance = await this.prisma.attendance.create({
        data: {
          tenantId,
          userId: dto.userId,
          scheduleId: schedule.id,
          workDate: schedule.workDate!,
          actualCheckinAt: isAbsent ? null : checkinAt,
          actualCheckoutAt: isCheckedOut ? checkoutAt : null,
          workedMinutes: isCheckedOut
            ? this.minutesBetween(checkinAt, checkoutAt!)
            : isAbsent
              ? 0
              : null,
          status: dto.status,
          manuallyCreatedById: user.userId,
          manuallyCreatedAt: now,
          manualCreationReason: dto.reason,
        },
      });
      return this.toResponse(attendance);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: ErrorCode.ATTENDANCE_ALREADY_EXISTS,
          message: 'This employee already has attendance for this shift',
        });
      }
      throw error;
    }
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Check-in opens 30 minutes before the shift and closes when it ends: clocking in afterwards is not a late arrival but a record that needs a manager and a reason. */
  private assertWithinCheckInWindow(
    checkinAt: Date,
    schedule: { startAt: Date | null; endAt: Date | null },
  ) {
    if (!schedule.startAt || !schedule.endAt) return;
    const opensAt = new Date(
      schedule.startAt.getTime() - ALLOWED_EARLY_CHECKIN_MINUTES * 60_000,
    );
    if (checkinAt < opensAt || checkinAt >= schedule.endAt) {
      throw new HttpException(
        {
          code: ErrorCode.ATTENDANCE_OUTSIDE_CHECKIN_WINDOW,
          message:
            'Check-in is only allowed during the shift or up to 30 minutes before it starts',
          errors: {
            actualCheckinAt: checkinAt,
            checkInOpenAt: opensAt,
            scheduleStartAt: schedule.startAt,
            scheduleEndAt: schedule.endAt,
            allowedEarlyCheckinMinutes: ALLOWED_EARLY_CHECKIN_MINUTES,
          },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /** The geofence of wherever this person is posted. */
  private async verifyAtWorkplace(
    tenantId: string,
    userId: string,
    point: GeoPoint,
  ): Promise<GeoVerdict> {
    const staff = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: {
        branch: {
          select: {
            attendanceLatitude: true,
            attendanceLongitude: true,
            attendanceAllowedRadiusMeters: true,
            attendanceMaxAccuracyMeters: true,
          },
        },
        warehouse: {
          select: {
            attendanceLatitude: true,
            attendanceLongitude: true,
            attendanceAllowedRadiusMeters: true,
            attendanceMaxAccuracyMeters: true,
          },
        },
      },
    });
    const workplace = staff?.branch ?? staff?.warehouse;
    if (!workplace) {
      throw new BadRequestException({
        code: ErrorCode.ACCOUNT_HAS_NO_LOCATION,
        message:
          'This account has not been assigned to a branch or a warehouse',
      });
    }

    return verifyWithinFence(
      {
        latitude: workplace.attendanceLatitude,
        longitude: workplace.attendanceLongitude,
        allowedRadiusMeters: workplace.attendanceAllowedRadiusMeters,
        maxAccuracyMeters: workplace.attendanceMaxAccuracyMeters,
      },
      point,
    );
  }

  /** The payroll period covering a work date, if it has been frozen - from REVIEW on a human has read the numbers, so the inputs stop moving. DRAFT stays editable. */
  private async assertPayrollPeriodOpen(tenantId: string, workDate: Date) {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: {
        tenantId,
        periodStart: { lte: workDate },
        periodEnd: { gte: workDate },
        status: { in: OPEN_PERIOD_STATUSES },
      },
      select: { id: true, status: true },
    });
    if (!period) return;

    if (ATTENDANCE_LOCKING_PERIOD_STATUSES.includes(period.status)) {
      throw new ConflictException({
        code: ErrorCode.ATTENDANCE_PAYROLL_LOCKED,
        message: `Attendance cannot be edited while the payroll period is ${period.status}`,
      });
    }
  }

  /** Which attendance rows this account may read: your own always, widened to your own location by `attendances:read`. */
  private readScope(user: AuthUser): StaffReadScope {
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    ) {
      return {};
    }
    if (!can(user, 'attendances', 'read')) return { userId: user.userId };
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
    if (can(user, 'attendances', 'read') && this.sameWorkplace(user, target)) {
      return;
    }
    throw new ForbiddenException({
      code: ErrorCode.ATTENDANCE_READ_DENIED,
      message: 'You are not allowed to view this attendance record',
    });
  }

  /** Writing somebody else's attendance - never your own, whatever your permissions, since the point of recording who made the edit is that it wasn't the person being paid. */
  private assertCanCorrect(
    user: AuthUser,
    target: { id: string; branchId: string | null; warehouseId: string | null },
  ) {
    if (target.id === user.userId) {
      throw new ForbiddenException({
        code: ErrorCode.ATTENDANCE_SELF_CORRECTION_DENIED,
        message: 'A manager cannot correct their own attendance',
      });
    }
    if (
      user.systemRole === SystemRole.TENANT_OWNER ||
      user.systemRole === SystemRole.ADMIN
    ) {
      return;
    }
    if (!this.sameWorkplace(user, target)) {
      throw new ForbiddenException({
        code: ErrorCode.ATTENDANCE_WRITE_DENIED,
        message: 'You are not allowed to edit this attendance record',
      });
    }
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
    query: QueryAttendanceDto,
    scope: StaffReadScope,
  ): Prisma.AttendanceWhereInput {
    const where: Prisma.AttendanceWhereInput = { tenantId };
    // Every client filter narrows the server-derived scope and none may replace it.
    const scoped = narrowStaffScope(scope, query, {
      own: 'You can only view your own attendance',
      location: 'You can only view attendance at your own location',
    });
    if (scoped.userId) where.userId = scoped.userId;
    if (scoped.branchId || scoped.warehouseId) {
      where.user = {
        ...(scoped.branchId ? { branchId: scoped.branchId } : {}),
        ...(scoped.warehouseId ? { warehouseId: scoped.warehouseId } : {}),
      };
    }
    if (query.scheduleId) where.scheduleId = query.scheduleId;

    if (query.checkinFrom || query.checkinTo) {
      where.actualCheckinAt = {
        ...(query.checkinFrom ? { gte: new Date(query.checkinFrom) } : {}),
        ...(query.checkinTo ? { lte: new Date(query.checkinTo) } : {}),
      };
    }

    if (query.missingCheckout) {
      if (query.checkoutFrom || query.checkoutTo) {
        throw new BadRequestException({
          code: ErrorCode.ATTENDANCE_FILTER_CONFLICT,
          message:
            'The missing-checkout filter cannot be combined with a checkout date range',
        });
      }
      where.actualCheckoutAt = null;
      where.status = AttendanceStatus.CHECKED_IN;
    } else if (query.checkoutFrom || query.checkoutTo) {
      where.actualCheckoutAt = {
        ...(query.checkoutFrom ? { gte: new Date(query.checkoutFrom) } : {}),
        ...(query.checkoutTo ? { lte: new Date(query.checkoutTo) } : {}),
      };
    }

    // `status` is applied after missingCheckout, which pins it to CHECKED_IN, so an explicit status alongside it loses - the old service resolved the clash the same way.
    if (query.status && !query.missingCheckout) where.status = query.status;

    if (query.lateOnly) where.lateMinutes = { gt: 0 };

    return where;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async lateGraceMinutes(tenantId: string): Promise<number> {
    const setting = await this.prisma.payrollSetting.findFirst({
      where: { tenantId, status: 'ACTIVE' },
      select: { lateGraceMinutes: true },
    });
    return setting?.lateGraceMinutes ?? DEFAULT_LATE_GRACE_MINUTES;
  }

  private minutesBetween(from: Date | null, to: Date): number {
    if (!from) return 0;
    return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  /** The flat geo columns go back out as the nested objects the old API returned. */
  private toResponse<T extends Attendance>(attendance: T) {
    const {
      checkInLatitude,
      checkInLongitude,
      checkInAccuracy,
      checkInDistance,
      checkInVerificationStatus,
      checkOutLatitude,
      checkOutLongitude,
      checkOutAccuracy,
      checkOutDistance,
      checkOutVerificationStatus,
      ...rest
    } = attendance;

    return {
      ...rest,
      checkInLocation:
        checkInLatitude === null
          ? null
          : {
              latitude: checkInLatitude,
              longitude: checkInLongitude,
              accuracy: checkInAccuracy,
              distance: checkInDistance,
              verificationStatus: checkInVerificationStatus,
            },
      checkOutLocation:
        checkOutLatitude === null
          ? null
          : {
              latitude: checkOutLatitude,
              longitude: checkOutLongitude,
              accuracy: checkOutAccuracy,
              distance: checkOutDistance,
              verificationStatus: checkOutVerificationStatus,
            },
    };
  }
}
