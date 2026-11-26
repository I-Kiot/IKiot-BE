import { LocationType } from '../../common/constants/location-type';
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
import { businessDate } from './business-date';
import { isOverdue, sessionWindow } from './session-window';
import { CashDrawerStatus, ShiftLogType } from './cash-drawer.constants';
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
import { CashFlowFund } from '../../common/constants/cash-flow-category';
import { Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  withNestedProfile,
  type FlatUserProfile,
} from '../../common/utils/user-profile';
import {
  BRANCH_NAME_SELECT,
  namedBranch,
} from '../../common/dto/location-ref.dto';

const STAFF_SELECT = {
  id: true,
  phoneNumber: true,
  profileFirstName: true,
  profileLastName: true,
} as const;

/** Điều kiện người giữ két: nhân viên đang hoạt động, gán đúng chi nhánh. */
function cashierWhere(
  tenantId: string,
  branchId: string,
): Prisma.UserWhereInput {
  return {
    tenantId,
    locationId: branchId,
    status: UserStatus.ACTIVE,
    systemRole: SystemRole.STAFF,
  };
}

/** Chỉ chọn tên cho ô chọn. */
const CASHIER_SELECT = {
  id: true,
  profileFirstName: true,
  profileLastName: true,
} as const satisfies Prisma.UserSelect;

const SESSION_INCLUDE = {
  branch: BRANCH_NAME_SELECT,
  openedBy: { select: STAFF_SELECT },
  currentStaff: { select: STAFF_SELECT },
  finalLogManager: { select: STAFF_SELECT },
  shiftLogs: {
    // Sắp theo id để thứ tự ổn định.
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

/** Chỉ các cột báo cáo chênh lệch cần, trên khoảng có thể dài cả năm. */
const VARIANCE_SELECT = {
  id: true,
  branchId: true,
  branch: BRANCH_NAME_SELECT,
  businessDate: true,
  status: true,
  openingAmount: true,
  finalLogAmount: true,
  createdAt: true,
  closedAt: true,
} as const satisfies Prisma.CashDrawerSessionSelect;

type VarianceRow = Prisma.CashDrawerSessionGetPayload<{
  select: typeof VARIANCE_SELECT;
}>;

interface SessionCashRow {
  sessionId: string;
  cashIn: Prisma.Decimal;
  cashOut: Prisma.Decimal;
  movementCount: number;
}

const DEFAULT_REPORT_DAYS = 30;
/** Khoảng tối đa của báo cáo: một năm và một ngày. */
const MAX_REPORT_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Két tiền theo ngày của chi nhánh: mở, chuyển ca qua sổ ca, chốt một lần. */
@Injectable()
export class CashDrawerSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async open(user: AuthUser, dto: OpenCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    // required = true nên ở đây không bao giờ null.
    const branchId = this.resolveBranch(user, dto.branchId)!;
    await this.assertBranchAndStaff(tenantId, branchId, dto.staffId);
    await this.assertNoOverdueAt(tenantId, branchId);

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
      // Báo két đã mở hoặc phiên hôm nay đã đóng.
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

    // Tóm tắt sổ ca thay vì trả toàn bộ.
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

  /** Két quá hạn trong phạm vi chi nhánh, ai ở chi nhánh cũng xem được. */
  async overdue(user: AuthUser, requestedBranchId?: string) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, requestedBranchId, false);
    const rows = await this.prisma.cashDrawerSession.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        status: CashDrawerStatus.OPEN,
      },
      select: {
        id: true,
        branchId: true,
        branch: BRANCH_NAME_SELECT,
        businessDate: true,
        status: true,
        currentStaff: { select: STAFF_SELECT },
      },
      orderBy: { businessDate: 'asc' },
    });
    // Lọc phiên quá hạn bằng `isOverdue`.
    return rows
      .filter((row) => isOverdue(row))
      .map(({ branch, currentStaff, status: _status, ...row }) => ({
        ...row,
        branch: namedBranch(branch),
        currentStaff: withNestedProfile(currentStaff),
      }));
  }

  /** Người nhận được két khi mở két đầu ngày tại chi nhánh. */
  async eligibleStaff(user: AuthUser, requestedBranchId?: string) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, requestedBranchId)!;
    await this.assertActiveBranch(tenantId, branchId);
    return this.listCashiers(tenantId, branchId);
  }

  /** Người nhận được bàn giao, chỉ người đang giữ két được hỏi. */
  async handoverCandidates(user: AuthUser, id: string) {
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
          'Only the cashier currently holding the drawer can hand it over',
      });
    }
    if (isOverdue(session)) throw this.overdueError(session);
    return this.listCashiers(session.tenantId, session.branchId, user.userId);
  }

  /** Tiền mặt lẽ ra phải có so với số đã đếm, theo ca. */
  async reconcile(user: AuthUser, id: string) {
    const session = await this.findRow(user, id);
    const window = sessionWindow(session);

    const [movements, nonCash] = await Promise.all([
      this.prisma.cashFlow.findMany({
        where: {
          ...this.sessionFlowWhere(session.tenantId, session.branchId, window),
          paymentMethod: PaymentMethod.CASH,
          // Chỉ tính tiền mặt qua két.
          fund: CashFlowFund.DRAWER,
        },
        select: { id: true, createdAt: true, flowType: true, amount: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.cashFlow.groupBy({
        by: ['paymentMethod', 'flowType'],
        where: {
          ...this.sessionFlowWhere(session.tenantId, session.branchId, window),
          // Dùng `NOT` để không bỏ sót phương thức NULL.
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
        branch: namedBranch(session.branch),
        businessDate: session.businessDate,
        status: session.status,
      },
      // Khoảng thời gian của phiên, xem `sessionWindow`.
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

  /** Đối soát nhiều ngày, lọc và phân trang trong bộ nhớ. */
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

    const cashBySession = await this.cashBySession(sessions);

    const all = sessions.map((session) =>
      this.varianceRow(session, cashBySession),
    );
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
      // Trên mọi phiên khớp bộ lọc, không phải trên trang.
      totals: this.reportTotals(rows),
    };
  }

  /** Mặc định 30 ngày giao dịch gần nhất, và từ chối khoảng phải phân trang. */
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

  /** Thu chi tiền mặt của từng phiên trong khoảng thời gian của nó. */
  private async cashBySession(
    sessions: VarianceRow[],
  ): Promise<Map<string, SessionCashRow>> {
    const now = new Date();
    const rows = await this.prisma.$queryRaw<SessionCashRow[]>`
      SELECT s.id AS "sessionId",
             COALESCE(SUM(CASE WHEN c.flow_type = ${FlowType.INCOME} THEN c.amount ELSE 0 END), 0) AS "cashIn",
             COALESCE(SUM(CASE WHEN c.flow_type <> ${FlowType.INCOME} THEN c.amount ELSE 0 END), 0) AS "cashOut",
             COUNT(*)::int AS "movementCount"
      FROM cash_drawer_sessions s
      JOIN cash_flows c
        ON c.tenant_id = s.tenant_id
       AND c.location_id = s.branch_id
       AND c.payment_method = ${PaymentMethod.CASH}
       -- Only cash that went through the drawer: remitted cash (fund OWNER) never did.
       AND c.fund = ${CashFlowFund.DRAWER}
       AND c.created_at >= s.created_at
       AND c.created_at < COALESCE(s.closed_at, ${now})
      WHERE s.id IN (${Prisma.join(sessions.map((session) => session.id))})
      GROUP BY s.id
    `;

    return new Map(rows.map((row) => [row.sessionId, row]));
  }

  private varianceRow(
    session: VarianceRow,
    cashBySession: Map<string, SessionCashRow>,
  ) {
    const day = cashBySession.get(session.id);
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
      branch: namedBranch(session.branch),
      businessDate: session.businessDate,
      status: session.status,
      overdue: isOverdue(session),
      movementCount: day?.movementCount ?? 0,
      ...summary,
    };
  }

  private reportTotals(rows: { variance: number | null }[]) {
    // Đếm riêng phiên chưa chốt.
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

  /** Điều kiện dòng tiền thuộc một phiên. */
  private sessionFlowWhere(
    tenantId: string,
    branchId: string,
    window: { start: Date; end: Date },
  ): Prisma.CashFlowWhereInput {
    return {
      tenantId,
      // id chi nhánh chính là id Location, cũng là thứ cash flow ghi lại.
      locationId: branchId,
      createdAt: { gte: window.start, lt: window.end },
    };
  }

  /** UUID không nói lên gì cho quản lý; báo cáo ghi tên thu ngân. */
  private nameStaff(segment: CashSegment, session: SessionRow) {
    const log = session.shiftLogs.find(
      (row) => row.staffId === segment.staffId,
    );
    return { ...segment, staff: log?.staff ?? null };
  }

  /** Ghi sổ ca nhận / trả két, kiểm thứ tự START/END. */
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
    // Két quá hạn không được bàn giao tiếp.
    if (isOverdue(session) && dto.nextStaffId) {
      throw this.overdueError(session);
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

    // Ai giữ két sau khi log này được ghi; ghi vô điều kiện, và điều này là then chốt (xem bên dưới).
    const nextHolder = dto.nextStaffId ?? user.userId;

    await this.prisma.$transaction(async (tx) => {
      // Ghi có điều kiện theo trạng thái để không insert hai lần.
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

  /** Chốt két với tổng đã đếm. */
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
        closedAt: new Date(),
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

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Chi nhánh của két đang gọi tới, null là mọi chi nhánh. */
  private resolveBranch(
    user: AuthUser,
    requested: string | undefined,
    required = true,
  ): string | null {
    if (user.branchId) {
      // Trưởng ca được tới chi nhánh ca đang bao phủ.
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

  /** Thấy mọi phiên của chi nhánh hay chỉ phiên của mình. */
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

  /** Kiểm chi nhánh đang hoạt động và thu ngân làm việc tại đó. */
  private async assertBranchAndStaff(
    tenantId: string,
    branchId: string,
    staffId: string,
  ) {
    const [, staff] = await Promise.all([
      this.assertActiveBranch(tenantId, branchId),
      this.prisma.user.findFirst({
        where: { id: staffId, ...cashierWhere(tenantId, branchId) },
        select: { id: true },
      }),
    ]);

    if (!staff) {
      throw new NotFoundException({
        code: ErrorCode.STAFF_NOT_AT_BRANCH,
        message: 'No active employee found at this branch',
      });
    }
  }

  /** Không mở két mới khi két ngày trước chưa chốt. */
  private async assertNoOverdueAt(tenantId: string, branchId: string) {
    const open = await this.prisma.cashDrawerSession.findFirst({
      where: { tenantId, branchId, status: CashDrawerStatus.OPEN },
      select: { id: true, status: true, businessDate: true },
    });
    if (open && isOverdue(open)) throw this.overdueError(open);
  }

  private overdueError(session: { id: string; businessDate: Date }) {
    return new ConflictException({
      code: ErrorCode.CASH_DRAWER_OVERDUE,
      message:
        'The drawer from a previous trading day is still open and must be closed first',
      sessionId: session.id,
      businessDate: session.businessDate,
    });
  }

  private async assertActiveBranch(tenantId: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: {
        id: branchId,
        tenantId,
        location: {
          status: LocationStatus.ACTIVE,
          type: LocationType.BRANCH,
        },
      },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException({
        code: ErrorCode.BRANCH_NOT_FOUND,
        message: 'No active branch found',
      });
    }
  }

  /** Danh sách người đủ điều kiện, chỉ tên: lọc bằng đúng `cashierWhere` mà bước kiểm tra khi ghi dùng. */
  private async listCashiers(
    tenantId: string,
    branchId: string,
    excludeUserId?: string,
  ) {
    const rows = await this.prisma.user.findMany({
      where: {
        ...cashierWhere(tenantId, branchId),
        ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      },
      select: CASHIER_SELECT,
      orderBy: [{ profileFirstName: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ profileFirstName, profileLastName, ...rest }) => ({
      ...rest,
      profile: {
        firstName: profileFirstName ?? null,
        lastName: profileLastName ?? null,
      },
    }));
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  private toResponse(session: SessionRow) {
    const {
      openingAmount,
      finalLogAmount,
      finalLogManagerId,
      finalLogNote,
      finalLogManager,
      shiftLogs,
      openedBy,
      currentStaff,
      ...rest
    } = session;
    // Trả user kèm `profile` lồng.
    const person = <T extends FlatUserProfile | null>(row: T) =>
      row ? withNestedProfile(row) : row;

    return {
      ...rest,
      branch: namedBranch(rest.branch),
      overdue: isOverdue(session),
      openedBy: person(openedBy),
      currentStaff: person(currentStaff),
      openingAmount: Number(openingAmount),
      // Đã lồng lại: các cột phẳng, nhưng API vẫn giữ object `finalLog` của iKiotMS-BE.
      finalLog:
        finalLogAmount === null
          ? null
          : {
              amount: Number(finalLogAmount),
              managerId: finalLogManagerId,
              manager: person(finalLogManager),
              note: finalLogNote,
            },
      shiftLogs: shiftLogs.map(({ staff, nextStaff, ...log }) => ({
        ...log,
        staff: person(staff),
        nextStaff: person(nextStaff),
        amount: Number(log.amount),
      })),
    };
  }

  /** Dòng danh sách: mọi thứ trừ lịch sử shift log, vốn dành cho chi tiết. */
  private toSummary(session: SessionRow) {
    const { shiftLogs, ...rest } = this.toResponse(session);
    return { ...rest, shiftLogCount: shiftLogs.length };
  }
}
