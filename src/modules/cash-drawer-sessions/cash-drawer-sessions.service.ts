import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationStatus } from '../../common/constants/location-status';
import { UserStatus } from '../../common/constants/user-status';
import { SystemRole } from '../../common/constants/system-role';
import { can } from '../../common/utils/permission';
import { paginate, skipFor } from '../../common/utils/pagination';
import type { AuthUser } from '../../common/types/auth-user.type';
import { supervisesLocation } from '../working-schedules/shift-supervisor.service';
import {
  businessDate,
  businessDayRange,
  formatBusinessDate,
} from './business-date';
import {
  BUSINESS_TIMEZONE,
  CashDrawerStatus,
  ShiftLogType,
} from './cash-drawer.constants';
import {
  FinalizeCashDrawerDto,
  OpenCashDrawerDto,
  QueryCashDrawerDto,
  QueryCashVarianceDto,
  SubmitShiftLogDto,
} from './dto/cash-drawer.dto';
import {
  reconcileSession,
  summarizeVariance,
  type CashMovement,
  type CashSegment,
} from './cash-reconciliation';
import { PaymentMethod } from '../../common/constants/payment-method';
import { FlowType } from '../stats/stats.constants';
import { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const STAFF_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
} as const;

const SESSION_INCLUDE = {
  branch: { select: { id: true, name: true } },
  openedBy: { select: STAFF_SELECT },
  currentStaff: { select: STAFF_SELECT },
  finalLogManager: { select: STAFF_SELECT },
  shiftLogs: {
    // `id` is only a tie-break so two logs a microsecond apart come back in a stable order; what actually keeps duplicates out is the guard in submitShiftLog.
    orderBy: [{ loggedAt: 'asc' }, { id: 'asc' }],
    include: {
      staff: { select: STAFF_SELECT },
      nextStaff: { select: STAFF_SELECT },
    },
  },
} as const satisfies Prisma.CashDrawerSessionInclude;

type SessionRow = Prisma.CashDrawerSessionGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/** Only the columns the variance report needs, over a range that may be a year long. */
const VARIANCE_SELECT = {
  id: true,
  branchId: true,
  branch: { select: { id: true, name: true } },
  businessDate: true,
  status: true,
  openingAmount: true,
  finalLogAmount: true,
} as const satisfies Prisma.CashDrawerSessionSelect;

type VarianceRow = Prisma.CashDrawerSessionGetPayload<{
  select: typeof VARIANCE_SELECT;
}>;

/** One branch's cash total for one trading day, as Postgres groups it. */
interface CashDayRow {
  branchId: string;
  day: string;
  cashIn: Prisma.Decimal;
  cashOut: Prisma.Decimal;
  movementCount: number;
}

const DEFAULT_REPORT_DAYS = 30;
/** A year and a day: the report loads every session in the range before paging, so the totals describe the range rather than the current page, and that trade needs a ceiling. */
const MAX_REPORT_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Real port of CashDrawerService: one branch's till for one trading day, opened with a counted float, passed between cashiers by shift logs, closed once with a counted total, so a shortfall can be narrowed to a shift. One session per branch per day and at most one OPEN session are both enforced by unique indexes; the branch comes from where the account is posted, and `cash_drawers:read` vs `read_own` decides how much of it they see. */
@Injectable()
export class CashDrawerSessionService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Open ──────────────────────────────────────────────────────────────────

  async open(user: AuthUser, dto: OpenCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    // required = true, so this is never null here.
    const branchId = this.resolveBranch(user, dto.branchId)!;
    await this.assertBranchAndStaff(tenantId, branchId, dto.staffId);

    try {
      const created = await this.prisma.cashDrawerSession.create({
        data: {
          tenantId,
          branchId,
          businessDate: businessDate(),
          openingAmount: dto.openingAmount,
          openedById: user.userId,
          currentStaffId: dto.staffId,
          status: CashDrawerStatus.OPEN,
        },
        include: SESSION_INCLUDE,
      });
      return this.toResponse(created);
    } catch (error) {
      // Either invariant can be the one that fired - a drawer already open, or today's session already closed - and both mean the same thing at the till.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: ErrorCode.CASH_DRAWER_ALREADY_OPEN,
          message:
            'This branch already has a drawer session for today, or one is still open',
        });
      }
      throw error;
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** The drawer currently open at a branch - what a till asks for on startup. */
  async current(user: AuthUser, requestedBranchId?: string) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, requestedBranchId)!;

    const session = await this.prisma.cashDrawerSession.findFirst({
      where: {
        tenantId,
        branchId,
        status: CashDrawerStatus.OPEN,
        ...this.ownershipFilter(user),
      },
      include: SESSION_INCLUDE,
    });
    if (!session) {
      throw new NotFoundException({
        code: ErrorCode.CASH_DRAWER_NONE_OPEN,
        message: 'No drawer session is currently open',
      });
    }
    return this.toResponse(session);
  }

  async findAll(user: AuthUser, query: QueryCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, query.branchId, false);

    const where: Prisma.CashDrawerSessionWhereInput = {
      tenantId,
      ...(branchId ? { branchId } : {}),
      ...this.ownershipFilter(user),
    };
    if (query.status) where.status = query.status;
    if (query.fromDate || query.toDate) {
      where.businessDate = {
        ...(query.fromDate ? { gte: new Date(query.fromDate) } : {}),
        ...(query.toDate ? { lte: new Date(query.toDate) } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.cashDrawerSession.findMany({
        where,
        include: SESSION_INCLUDE,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.cashDrawerSession.count({ where }),
    ]);

    // The old list dropped shiftLogs to keep the payload small; the summary keeps the useful part (how many shifts, who holds it) without the full history.
    return paginate(
      rows.map((row) => this.toSummary(row)),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(user: AuthUser, id: string) {
    return this.toResponse(await this.findRow(user, id));
  }

  // ─── Reconciliation ────────────────────────────────────────────────────────

  /** What the drawer should hold against what was counted, broken down by shift - the subtraction neither codebase ever made, so a till could close half a million đồng short in silence. Cash only: a card or SePay sale never enters the drawer, so non-cash takings are returned as context and never inside the variance. */
  async reconcile(user: AuthUser, id: string) {
    const session = await this.findRow(user, id);
    const window = businessDayRange(session.businessDate);

    const [movements, nonCash] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where: {
          ...this.dayFlowWhere(session.tenantId, session.branchId, window),
          paymentMethod: PaymentMethod.CASH,
        },
        select: { id: true, createdAt: true, flowType: true, amount: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.cashFlow.groupBy({
        by: ['paymentMethod', 'flowType'],
        where: {
          ...this.dayFlowWhere(session.tenantId, session.branchId, window),
          // `NOT`, not `paymentMethod: { not: 'CASH' }` - the column is nullable and Prisma's `not` drops NULLs, so an unrecorded method would be reported nowhere.
          NOT: { paymentMethod: PaymentMethod.CASH },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const result = reconcileSession({
      openingAmount: Number(session.openingAmount),
      finalAmount:
        session.finalLogAmount === null ? null : Number(session.finalLogAmount),
      shiftLogs: session.shiftLogs.map((log) => ({
        type: log.type,
        staffId: log.staffId,
        amount: Number(log.amount),
        loggedAt: log.loggedAt,
      })),
      movements: movements.map((row): CashMovement => ({
        at: row.createdAt,
        flowType: row.flowType,
        amount: Number(row.amount),
      })),
    });

    return {
      session: {
        id: session.id,
        branchId: session.branchId,
        branch: session.branch,
        businessDate: session.businessDate,
        status: session.status,
      },
      // The exact instants the totals cover, so a disagreement about a receipt near midnight can be settled by looking.
      window,
      ...result,
      segments: result.segments.map((segment) =>
        this.nameStaff(segment, session),
      ),
      nonCash: nonCash.map((row) => ({
        paymentMethod: row.paymentMethod,
        flowType: row.flowType,
        amount: Number(row._sum.amount ?? 0),
        count: row._count._all,
      })),
    };
  }

  /** The same subtraction over a range of days: two queries whatever the range, then filtering and paging in memory, so `varianceOnly` and the totals describe the whole range rather than one page. */
  async report(user: AuthUser, query: QueryCashVarianceDto) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, query.branchId, false);
    const { fromDate, toDate } = this.reportRange(query);

    const where: Prisma.CashDrawerSessionWhereInput = {
      tenantId,
      ...(branchId ? { branchId } : {}),
      ...this.ownershipFilter(user),
      businessDate: { gte: fromDate, lte: toDate },
      ...(query.status ? { status: query.status } : {}),
    };

    const sessions = await this.prisma.cashDrawerSession.findMany({
      where,
      select: VARIANCE_SELECT,
      orderBy: [{ businessDate: 'desc' }, { branchId: 'asc' }],
    });
    if (sessions.length === 0) {
      return this.emptyReport(query, fromDate, toDate);
    }

    const cashByDay = await this.cashByBusinessDay(
      tenantId,
      branchId,
      fromDate,
      toDate,
    );

    const all = sessions.map((session) => this.varianceRow(session, cashByDay));
    const rows = query.varianceOnly
      ? all.filter((row) => row.variance !== null && row.variance !== 0)
      : all;

    const start = skipFor(query.page, query.limit);
    return {
      ...paginate(
        rows.slice(start, start + query.limit),
        rows.length,
        query.page,
        query.limit,
      ),
      period: { fromDate, toDate },
      // Over every session the filter matched, not over the page.
      totals: this.reportTotals(rows),
    };
  }

  /** Defaults to the last 30 trading days, and refuses a range it would have to page. */
  private reportRange(query: QueryCashVarianceDto): {
    fromDate: Date;
    toDate: Date;
  } {
    const toDate = query.toDate
      ? businessDate(new Date(query.toDate))
      : businessDate();
    const fromDate = query.fromDate
      ? businessDate(new Date(query.fromDate))
      : new Date(toDate.getTime() - (DEFAULT_REPORT_DAYS - 1) * MS_PER_DAY);

    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException({
        code: ErrorCode.DATE_RANGE_INVALID,
        message: 'fromDate must be on or before toDate',
      });
    }
    const days = (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY + 1;
    if (days > MAX_REPORT_DAYS) {
      throw new BadRequestException({
        code: ErrorCode.REPORT_RANGE_TOO_LONG,
        message: `The report range is at most ${MAX_REPORT_DAYS} days`,
      });
    }
    return { fromDate, toDate };
  }

  /** Cash in and out per branch per trading day, bucketed by `AT TIME ZONE` in Postgres so a 23:30 sale isn't filed under tomorrow; the `created_at` bounds stay a plain range so the index is still usable. */
  private async cashByBusinessDay(
    tenantId: string,
    branchId: string | null,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, CashDayRow>> {
    const start = businessDayRange(fromDate).start;
    const end = businessDayRange(toDate).end;

    const rows = await this.prisma.$queryRaw<CashDayRow[]>`
      SELECT branch_id AS "branchId",
             to_char(created_at AT TIME ZONE ${BUSINESS_TIMEZONE}, 'YYYY-MM-DD') AS "day",
             COALESCE(SUM(CASE WHEN flow_type = ${FlowType.INCOME} THEN amount ELSE 0 END), 0) AS "cashIn",
             COALESCE(SUM(CASE WHEN flow_type <> ${FlowType.INCOME} THEN amount ELSE 0 END), 0) AS "cashOut",
             COUNT(*)::int AS "movementCount"
      FROM cash_flows
      WHERE tenant_id = ${tenantId}
        AND payment_method = ${PaymentMethod.CASH}
        AND branch_id IS NOT NULL
        AND created_at >= ${start}
        AND created_at < ${end}
        ${branchId ? Prisma.sql`AND branch_id = ${branchId}` : Prisma.empty}
      GROUP BY 1, 2
    `;

    return new Map(rows.map((row) => [`${row.branchId}|${row.day}`, row]));
  }

  private varianceRow(
    session: VarianceRow,
    cashByDay: Map<string, CashDayRow>,
  ) {
    const day = cashByDay.get(
      `${session.branchId}|${formatBusinessDate(session.businessDate)}`,
    );
    const summary = summarizeVariance({
      openingAmount: Number(session.openingAmount),
      finalAmount:
        session.finalLogAmount === null ? null : Number(session.finalLogAmount),
      cashIn: Number(day?.cashIn ?? 0),
      cashOut: Number(day?.cashOut ?? 0),
    });

    return {
      sessionId: session.id,
      branchId: session.branchId,
      branch: session.branch,
      businessDate: session.businessDate,
      status: session.status,
      movementCount: day?.movementCount ?? 0,
      ...summary,
    };
  }

  private reportTotals(rows: { variance: number | null }[]) {
    // A session nobody has closed has no counted total, so it is neither balanced nor off - counted separately rather than folded into either tally.
    const settled = rows.filter((row) => row.variance !== null);
    const off = settled.filter((row) => row.variance !== 0);
    return {
      sessions: rows.length,
      openSessions: rows.length - settled.length,
      sessionsWithVariance: off.length,
      totalVariance: off.reduce((sum, row) => sum + (row.variance ?? 0), 0),
      shortfall: off
        .filter((row) => (row.variance ?? 0) < 0)
        .reduce((sum, row) => sum + (row.variance ?? 0), 0),
      overage: off
        .filter((row) => (row.variance ?? 0) > 0)
        .reduce((sum, row) => sum + (row.variance ?? 0), 0),
    };
  }

  private emptyReport(
    query: QueryCashVarianceDto,
    fromDate: Date,
    toDate: Date,
  ) {
    return {
      ...paginate([], 0, query.page, query.limit),
      period: { fromDate, toDate },
      totals: this.reportTotals([]),
    };
  }

  /** Which cash rows belong to one branch's trading day. `branchId` is required, so branchless EXPENSE rows (a supplier paid in cash, a payroll period marked paid) are not counted - a shop paying a supplier from the drawer shows that day short, and rightly so. */
  private dayFlowWhere(
    tenantId: string,
    branchId: string,
    window: { start: Date; end: Date },
  ): Prisma.CashFlowWhereInput {
    return {
      tenantId,
      branchId,
      createdAt: { gte: window.start, lt: window.end },
    };
  }

  /** A uuid tells a manager nothing; the report names the cashier. */
  private nameStaff(segment: CashSegment, session: SessionRow) {
    const log = session.shiftLogs.find(
      (row) => row.staffId === segment.staffId,
    );
    return { ...segment, staff: log?.staff ?? null };
  }

  // ─── Shift logs ────────────────────────────────────────────────────────────

  /** Records a cashier taking the drawer or handing it back. The sequence is checked rather than assumed - a START only opens the session or follows an END that named this person - because otherwise a shortfall becomes unattributable. */
  async submitShiftLog(user: AuthUser, id: string, dto: SubmitShiftLogDto) {
    const tenantId = this.tenantOf(user);
    const session = await this.findRow(user, id);

    if (session.status !== CashDrawerStatus.OPEN) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_CLOSED,
        message: 'This drawer session is closed',
      });
    }
    if (session.currentStaffId !== user.userId) {
      throw new ForbiddenException({
        code: ErrorCode.CASH_DRAWER_NOT_HOLDER,
        message:
          'Only the cashier currently holding the drawer can file a shift log',
      });
    }
    if (dto.type === ShiftLogType.START && dto.nextStaffId) {
      throw new BadRequestException({
        code: ErrorCode.SHIFT_LOG_NEXT_STAFF_INVALID,
        message: 'nextStaffId is only valid on an END shift log',
      });
    }

    const lastLog = session.shiftLogs.at(-1);
    if (dto.type === ShiftLogType.START) {
      const isFirstShift = !lastLog;
      const handedToMe =
        lastLog?.type === ShiftLogType.END &&
        lastLog.nextStaffId === user.userId;
      if (!isFirstShift && !handedToMe) {
        throw new ConflictException({
          code: ErrorCode.SHIFT_LOG_HANDOVER_INVALID,
          message:
            'This shift has already started, or the drawer was not handed over to you',
        });
      }
    } else {
      const startedByMe =
        lastLog?.type === ShiftLogType.START && lastLog.staffId === user.userId;
      if (!startedByMe) {
        throw new ConflictException({
          code: ErrorCode.SHIFT_LOG_START_REQUIRED,
          message: 'A START shift log is required first',
        });
      }
    }

    if (dto.nextStaffId) {
      if (dto.nextStaffId === user.userId) {
        throw new BadRequestException({
          code: ErrorCode.SHIFT_LOG_NEXT_STAFF_SELF,
          message: 'The next cashier must be somebody else',
        });
      }
      await this.assertBranchAndStaff(
        tenantId,
        session.branchId,
        dto.nextStaffId,
      );
    }

    // Who holds the drawer once this log is written; written unconditionally, which is load-bearing - see below.
    const nextHolder = dto.nextStaffId ?? user.userId;

    await this.prisma.$transaction(async (tx) => {
      // Guarded on the state we read, and `data` must never be empty: `updateMany({ data: {} })` matches the row without touching `@updatedAt`, so a double tap or client retry would insert twice. iKiotMS-BE got this free from `$push` on an embedded array.
      const claimed = await tx.cashDrawerSession.updateMany({
        where: {
          id,
          tenantId,
          status: CashDrawerStatus.OPEN,
          currentStaffId: user.userId,
          updatedAt: session.updatedAt,
        },
        data: { currentStaffId: nextHolder },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.CASH_DRAWER_CONFLICT,
          message:
            'The drawer session has just changed, please reload and try again',
        });
      }

      await tx.cashDrawerShiftLog.create({
        data: {
          sessionId: id,
          type: dto.type,
          staffId: user.userId,
          amount: dto.amount,
          nextStaffId: dto.nextStaffId,
          note: dto.note,
        },
      });
    });

    return this.toResponse(await this.findRow(user, id));
  }

  /** Closes the day with a counted total. Refused unless the last log is an `END` from the holder naming nobody to take over - that log is the handover to the manager. */
  async finalize(user: AuthUser, id: string, dto: FinalizeCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    const session = await this.findRow(user, id);

    if (session.status !== CashDrawerStatus.OPEN) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_CLOSED,
        message: 'This drawer session is closed',
      });
    }

    const lastLog = session.shiftLogs.at(-1);
    const closedOut =
      lastLog?.type === ShiftLogType.END &&
      lastLog.staffId === session.currentStaffId &&
      lastLog.nextStaffId === null;
    if (!closedOut) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_END_LOG_REQUIRED,
        message:
          'The cashier holding the drawer must file the final END log before it can be closed',
      });
    }

    const claimed = await this.prisma.cashDrawerSession.updateMany({
      where: {
        id,
        tenantId,
        status: CashDrawerStatus.OPEN,
        updatedAt: session.updatedAt,
      },
      data: {
        status: CashDrawerStatus.CLOSED,
        finalLogAmount: dto.finalAmount,
        finalLogManagerId: user.userId,
        finalLogNote: dto.note,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_CONFLICT,
        message:
          'The drawer session has just changed, please reload and try again',
      });
    }

    return this.toResponse(await this.findRow(user, id));
  }

  // ─── Access ────────────────────────────────────────────────────────────────

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Which branch's drawer this call is about, or `null` for every branch: a posting wins (naming another is a 403), an owner may name one, and anyone else with no posting is refused rather than falling through to "no filter". Never `''`, which would one day land in a `where` as a real id. */
  private resolveBranch(
    user: AuthUser,
    requested: string | undefined,
    required = true,
  ): string | null {
    if (user.branchId) {
      // A shift supervisor reaches the branch their live shift covers - already intersected with their posting, but checked so the rule reads the same as in stock movements.
      const allowed =
        requested === user.branchId ||
        supervisesLocation(user.shiftSupervision, {
          branchId: requested ?? null,
          warehouseId: null,
        });
      if (requested && !allowed) {
        throw new ForbiddenException({
          code: ErrorCode.CASH_DRAWER_BRANCH_DENIED,
          message: 'You cannot operate another branch drawer',
        });
      }
      return user.branchId;
    }

    if (
      user.systemRole !== SystemRole.TENANT_OWNER &&
      user.systemRole !== SystemRole.ADMIN
    ) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
        message: 'This account has not been assigned to a branch',
      });
    }

    if (requested) return requested;
    if (required) {
      throw new BadRequestException({
        code: ErrorCode.BRANCH_ID_REQUIRED,
        message: 'branchId is required',
      });
    }
    return null;
  }

  /** Whether this account sees every session at the branch (`cash_drawers:read`) or only the ones it worked (`read_own`). */
  private ownershipFilter(user: AuthUser): Prisma.CashDrawerSessionWhereInput {
    if (can(user, 'cash_drawers', 'read')) return {};
    return {
      OR: [
        { currentStaffId: user.userId },
        { shiftLogs: { some: { staffId: user.userId } } },
      ],
    };
  }

  private async findRow(user: AuthUser, id: string): Promise<SessionRow> {
    const branchId = this.resolveBranch(user, undefined, false);
    const session = await this.prisma.cashDrawerSession.findFirst({
      where: {
        id,
        tenantId: this.tenantOf(user),
        ...(branchId ? { branchId } : {}),
        ...this.ownershipFilter(user),
      },
      include: SESSION_INCLUDE,
    });
    if (!session)
      throw new NotFoundException({
        code: ErrorCode.CASH_DRAWER_NOT_FOUND,
        message: 'Drawer session not found',
      });
    return session;
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  /** The branch has to be live and the cashier has to actually work there - what remains of the old check once its STAFF-family role test is dropped. */
  private async assertBranchAndStaff(
    tenantId: string,
    branchId: string,
    staffId: string,
  ) {
    const [branch, staff] = await Promise.all([
      this.prisma.branch.findFirst({
        where: { id: branchId, tenantId, status: LocationStatus.ACTIVE },
        select: { id: true },
      }),
      this.prisma.user.findFirst({
        where: {
          id: staffId,
          tenantId,
          branchId,
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.STAFF,
        },
        select: { id: true },
      }),
    ]);

    if (!branch) {
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'No active branch found',
      });
    }
    if (!staff) {
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_AT_BRANCH,
        message: 'No active employee found at this branch',
      });
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  // ─── Shapes ────────────────────────────────────────────────────────────────

  private toResponse(session: SessionRow) {
    const {
      openingAmount,
      finalLogAmount,
      finalLogManagerId,
      finalLogNote,
      finalLogManager,
      shiftLogs,
      ...rest
    } = session;

    return {
      ...rest,
      openingAmount: Number(openingAmount),
      // Re-nested: the columns are flat but the API kept iKiotMS-BE's `finalLog` object.
      finalLog:
        finalLogAmount === null
          ? null
          : {
              amount: Number(finalLogAmount),
              managerId: finalLogManagerId,
              manager: finalLogManager,
              note: finalLogNote,
            },
      shiftLogs: shiftLogs.map((log) => ({
        ...log,
        amount: Number(log.amount),
      })),
    };
  }

  /** List rows: everything except the shift-log history, which is what detail is for. */
  private toSummary(session: SessionRow) {
    const { shiftLogs, ...rest } = this.toResponse(session);
    return { ...rest, shiftLogCount: shiftLogs.length };
  }
}
