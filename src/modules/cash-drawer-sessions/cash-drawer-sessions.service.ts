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
  ReopenCashDrawerDto,
  SubmitShiftLogDto,
} from './dto/cash-drawer.dto';
import { summarizeByCashier } from './cashier-summary';
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
import { bookClosing, bookOpening, keptAmountOf } from './drawer-cash-flow';
import {
  ReportSheet,
  formatDateVi,
  newWorkbook,
  toBuffer,
} from '../stats/export/report-sheet';
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
  lastReopenedBy: { select: STAFF_SELECT },
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
  withdrawnAmount: true,
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
/** Két được mở lại sau lần ghi sổ ca này (lần trả két cuối trước khi chốt nhầm). */
function reopenedAfter(
  session: { lastReopenedAt: Date | null },
  log: { loggedAt: Date },
): boolean {
  return (
    !!session.lastReopenedAt &&
    session.lastReopenedAt.getTime() > log.loggedAt.getTime()
  );
}

@Injectable()
export class CashDrawerSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async open(user: AuthUser, dto: OpenCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    // required = true nên ở đây không bao giờ null.
    const branchId = this.resolveBranch(user, dto.branchId)!;
    await this.assertBranchAndStaff(tenantId, branchId, dto.staffId);
    await this.assertNoOverdueAt(tenantId, branchId);
    await this.assertNotClosedToday(tenantId, branchId);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        // Đọc trong transaction: số để lại của phiên trước quyết định dòng sổ ghi lúc mở.
        const previous = await this.lastClosedAt(tx, tenantId, branchId);
        const session = await tx.cashDrawerSession.create({
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
        await bookOpening(
          tx,
          { tenantId, branchId, sessionId: session.id, actorId: user.userId },
          {
            openingAmount: dto.openingAmount,
            keptAmount: previous ? keptAmountOf(previous) : 0,
            at: session.createdAt,
          },
        );
        return session;
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

  /**
   * Tiền lẻ phiên trước để lại trong két, để màn mở két điền sẵn tiền đầu ca. Đếm khác số này thì lúc mở sẽ ghi
   * chủ bỏ thêm (chuyển quỹ) hoặc thiếu két.
   */
  async openingHint(user: AuthUser, requestedBranchId?: string) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, requestedBranchId)!;
    const previous = await this.lastClosedAt(this.prisma, tenantId, branchId);
    return {
      branchId,
      keptAmount: previous ? keptAmountOf(previous) : 0,
      previousSession: previous
        ? {
            id: previous.id,
            businessDate: previous.businessDate,
            closedAt: previous.closedAt,
          }
        : null,
    };
  }

  /** Phiên đã chốt gần nhất của chi nhánh. */
  private lastClosedAt(
    client: Prisma.TransactionClient | PrismaService,
    tenantId: string,
    branchId: string,
  ) {
    return client.cashDrawerSession.findFirst({
      where: { tenantId, branchId, status: CashDrawerStatus.CLOSED },
      orderBy: [{ closedAt: 'desc' }, { businessDate: 'desc' }],
      select: {
        id: true,
        businessDate: true,
        closedAt: true,
        finalLogAmount: true,
        withdrawnAmount: true,
      },
    });
  }

  /**
   * Két hôm nay của một chi nhánh, cho màn "Hôm nay": OPEN (đang mở, kể cả két quá hạn từ ngày trước), CLOSED_TODAY
   * (phiên của ngày giao dịch hôm nay đã chốt - mỗi chi nhánh một phiên một ngày, nên không mở lại được), NOT_OPENED.
   * `current` chỉ tìm phiên đang mở, nên một két đã chốt trông y như chưa mở và màn hình mời mở két lần hai.
   * `session` theo đúng quyền đọc (`read_own` chỉ thấy phiên mình từng giữ); trạng thái và người giữ / người chốt
   * thì ai ở chi nhánh cũng được biết, không kèm số tiền.
   */
  async today(user: AuthUser, requestedBranchId?: string) {
    const tenantId = this.tenantOf(user);
    const branchId = this.resolveBranch(user, requestedBranchId)!;
    const today = businessDate();

    const open = await this.prisma.cashDrawerSession.findFirst({
      where: { tenantId, branchId, status: CashDrawerStatus.OPEN },
      select: {
        id: true,
        status: true,
        businessDate: true,
        currentStaff: { select: STAFF_SELECT },
      },
    });
    if (open) {
      return {
        branchId,
        businessDate: today,
        state: 'OPEN' as const,
        sessionId: open.id,
        overdue: isOverdue(open),
        holder: withNestedProfile(open.currentStaff),
        session: await this.visibleSummary(user, open.id),
      };
    }

    const closed = await this.prisma.cashDrawerSession.findFirst({
      where: {
        tenantId,
        branchId,
        businessDate: today,
        status: CashDrawerStatus.CLOSED,
      },
      select: {
        id: true,
        closedAt: true,
        finalLogManager: { select: STAFF_SELECT },
      },
    });
    if (closed) {
      return {
        branchId,
        businessDate: today,
        state: 'CLOSED_TODAY' as const,
        sessionId: closed.id,
        closedAt: closed.closedAt,
        closedBy: closed.finalLogManager
          ? withNestedProfile(closed.finalLogManager)
          : null,
        session: await this.visibleSummary(user, closed.id),
      };
    }

    return { branchId, businessDate: today, state: 'NOT_OPENED' as const };
  }

  /** Phiên dạng tóm tắt nếu người gọi được đọc nó, null nếu không (vd. `read_own` không giữ két). */
  private async visibleSummary(user: AuthUser, id: string) {
    const row = await this.prisma.cashDrawerSession.findFirst({
      where: { id, ...this.ownershipFilter(user) },
      include: SESSION_INCLUDE,
    });
    return row ? this.toSummary(row) : null;
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
          // Dòng két tự ghi khi mở / chốt đã nằm trong số đếm, không phải giao dịch trong phiên.
          cashDrawerSessionId: null,
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
    const { rows, fromDate, toDate } = await this.reportRows(user, query);
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

  /** File Excel của báo cáo đối soát: cùng bộ lọc, mọi dòng (không phân trang). */
  async exportReport(
    user: AuthUser,
    query: QueryCashVarianceDto,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const { rows, fromDate, toDate } = await this.reportRows(user, query);
    const totals = this.reportTotals(rows);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const place =
      query.branchId && rows[0]?.branch?.name
        ? rows[0].branch.name
        : 'Toàn cửa hàng';

    const workbook = newWorkbook();
    const sheet = new ReportSheet(
      workbook.addWorksheet('Lịch sử két'),
      [12, 22, 14, 14, 14, 14, 14, 14, 14, 14, 14],
    );
    sheet.title('Lịch sử két tiền', [
      `Từ ngày ${formatDateVi(day(fromDate))} đến ngày ${formatDateVi(day(toDate))} - ${place}`,
    ]);
    sheet.tableHeader(
      [
        'Ngày',
        'Chi nhánh',
        'Trạng thái',
        'Đầu ca',
        'Thu tiền mặt',
        'Chi tiền mặt',
        'Theo sổ',
        'Đếm được',
        'Chênh lệch',
        'Chủ rút về',
        'Để lại',
      ],
      [3, 4, 5, 6, 7, 8, 9, 10],
    );
    for (const row of rows) {
      sheet.dataRow([
        formatDateVi(day(row.businessDate)),
        row.branch?.name ?? '-',
        row.overdue
          ? 'Quên chốt'
          : row.status === CashDrawerStatus.OPEN
            ? 'Đang mở'
            : 'Đã chốt',
        row.openingAmount,
        row.cashIn,
        row.cashOut,
        row.expectedClosing,
        row.countedClosing,
        row.variance,
        row.withdrawnAmount,
        row.keptAmount,
      ]);
    }
    if (rows.length === 0) sheet.emptyRow('Không có phiên két nào trong kỳ');
    sheet.dataRow(
      [
        'Tổng cộng',
        `${totals.sessions} phiên`,
        null,
        null,
        null,
        null,
        null,
        null,
        totals.totalVariance,
        totals.withdrawn,
        null,
      ],
      { strong: true },
    );
    sheet.blank();
    sheet.note(
      `Thiếu ${totals.shortfall.toLocaleString('vi-VN')}đ ở ${totals.shortfallSessions} phiên · thừa ${totals.overage.toLocaleString('vi-VN')}đ. Chênh lệch = đếm được − theo sổ; chỉ tính tiền mặt qua két.`,
    );

    return {
      buffer: await toBuffer(workbook),
      filename: `lich-su-ket_${day(fromDate)}_${day(toDate)}.xlsx`,
    };
  }

  /** Mọi phiên khớp bộ lọc báo cáo, đã đối soát; trang và file Excel dùng chung. */
  /** Điều kiện phiên của báo cáo: một chỗ cho bảng phiên, file Excel và bảng theo thu ngân. */
  private reportWhere(user: AuthUser, query: QueryCashVarianceDto) {
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
    return { tenantId, where, fromDate, toDate };
  }

  /**
   * Chênh lệch gộp theo thu ngân trong kỳ. Chạy lại đúng `reconcileSession` cho từng phiên (một query tiền mặt cho
   * mọi phiên), nên số khớp với bảng theo ca của từng phiên. Người chỉ có `read_own` chỉ thấy dòng của mình.
   */
  async cashierReport(user: AuthUser, query: QueryCashVarianceDto) {
    const { tenantId, where, fromDate, toDate } = this.reportWhere(user, query);
    const period = { fromDate, toDate };

    const sessions = await this.prisma.cashDrawerSession.findMany({
      where,
      select: {
        id: true,
        branchId: true,
        openingAmount: true,
        finalLogAmount: true,
        createdAt: true,
        closedAt: true,
        shiftLogs: {
          select: { type: true, staffId: true, amount: true, loggedAt: true },
          orderBy: [{ loggedAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (sessions.length === 0) {
      return { data: [], unattributed: [], period };
    }

    const windows = sessions.map((session) => ({
      session,
      window: sessionWindow(session),
    }));
    const start = new Date(
      Math.min(...windows.map((w) => w.window.start.getTime())),
    );
    const end = new Date(
      Math.max(...windows.map((w) => w.window.end.getTime())),
    );
    // Cùng điều kiện với `reconcile`: tiền mặt qua két, bỏ dòng két tự ghi.
    const movements = await this.prisma.cashFlow.findMany({
      where: {
        tenantId,
        locationId: { in: [...new Set(sessions.map((s) => s.branchId))] },
        paymentMethod: PaymentMethod.CASH,
        fund: CashFlowFund.DRAWER,
        cashDrawerSessionId: null,
        createdAt: { gte: start, lt: end },
      },
      select: {
        locationId: true,
        createdAt: true,
        flowType: true,
        amount: true,
      },
    });
    const byBranch = new Map<string, CashMovement[]>();
    for (const row of movements) {
      if (!row.locationId) continue;
      const list = byBranch.get(row.locationId) ?? [];
      list.push({
        at: row.createdAt,
        flowType: row.flowType,
        amount: Number(row.amount),
      });
      byBranch.set(row.locationId, list);
    }

    const summary = summarizeByCashier(
      windows.map(({ session, window }) => ({
        sessionId: session.id,
        segments: reconcileSession({
          openingAmount: Number(session.openingAmount),
          finalAmount:
            session.finalLogAmount === null
              ? null
              : Number(session.finalLogAmount),
          shiftLogs: session.shiftLogs.map((log) => ({
            type: log.type,
            staffId: log.staffId,
            amount: Number(log.amount),
            loggedAt: log.loggedAt,
          })),
          movements: (byBranch.get(session.branchId) ?? []).filter(
            (m) =>
              m.at.getTime() >= window.start.getTime() &&
              m.at.getTime() < window.end.getTime(),
          ),
        }).segments,
      })),
    );

    // Không có quyền xem cả chi nhánh: chỉ dòng của chính mình, không thấy khoản lệch không gán cho ai.
    const seesAll = can(user, 'cash_drawers', 'read');
    const rows = seesAll
      ? summary.rows
      : summary.rows.filter((row) => row.staffId === user.userId);

    const staff = await this.prisma.user.findMany({
      where: { tenantId, id: { in: rows.map((row) => row.staffId) } },
      select: STAFF_SELECT,
    });
    const nameOf = new Map(staff.map((s) => [s.id, withNestedProfile(s)]));

    return {
      data: rows.map((row) => ({
        ...row,
        staff: nameOf.get(row.staffId) ?? null,
      })),
      unattributed: seesAll ? summary.unattributed : [],
      period,
    };
  }

  private async reportRows(user: AuthUser, query: QueryCashVarianceDto) {
    const { where, fromDate, toDate } = this.reportWhere(user, query);

    const sessions = await this.prisma.cashDrawerSession.findMany({
      where,
      select: VARIANCE_SELECT,
      orderBy: [{ businessDate: 'desc' }, { branchId: 'asc' }],
    });
    if (sessions.length === 0) {
      return { rows: [], fromDate, toDate };
    }

    const cashBySession = new Map(
      (await this.cashBySession(sessions)).map((row) => [row.sessionId, row]),
    );

    const all = sessions.map((session) =>
      this.varianceRow(session, cashBySession),
    );
    const rows = query.varianceOnly
      ? all.filter((row) => row.variance !== null && row.variance !== 0)
      : all;
    return { rows, fromDate, toDate };
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
    sessions: Pick<VarianceRow, 'id'>[],
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<SessionCashRow[]> {
    const now = new Date();
    return client.$queryRaw<SessionCashRow[]>`
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
       -- Rows the drawer itself books on open / close are already in the counts.
       AND c.cash_drawer_session_id IS NULL
       AND c.created_at >= s.created_at
       AND c.created_at < COALESCE(s.closed_at, ${now})
      WHERE s.id IN (${Prisma.join(sessions.map((session) => session.id))})
      GROUP BY s.id
    `;
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
      // null khi còn mở, hoặc chốt trước khi có tính năng rút tiền.
      withdrawnAmount:
        session.withdrawnAmount === null
          ? null
          : Number(session.withdrawnAmount),
      keptAmount:
        session.finalLogAmount === null ? null : keptAmountOf(session),
    };
  }

  private reportTotals(
    rows: {
      variance: number | null;
      withdrawnAmount?: number | null;
      overdue?: boolean;
    }[],
  ) {
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
      shortfallSessions: off.filter((row) => (row.variance ?? 0) < 0).length,
      // Chủ rút về từ các két trong kỳ.
      withdrawn: rows.reduce((sum, row) => sum + (row.withdrawnAmount ?? 0), 0),
      overdueSessions: rows.filter((row) => row.overdue === true).length,
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
      // Két mở lại sau lần trả cuối: người quản lý giao két (đã là người giữ két) nhận lại.
      const reopenedToMe = !!lastLog && reopenedAfter(session, lastLog);
      if (!isFirstShift && !handedToMe && !reopenedToMe) {
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
  /**
   * Mở lại két chốt nhầm (2026-11-27). Chỉ phiên của ngày giao dịch hôm nay: số của ngày đã qua đã nằm trong báo cáo.
   * Phiên về OPEN, giao cho `staffId`; kết quả chốt bị xoá và các dòng sổ ghi lúc chốt (thừa / thiếu, chủ rút) bị gỡ,
   * vì chúng là kết luận của một lần chốt không còn đúng - chốt lại sẽ ghi lại theo số mới. Dòng ghi lúc mở két giữ nguyên.
   * Người nhận phải START (đếm lúc nhận) rồi END trước khi chốt lại; tiền bán trong lúc két đóng rơi vào đoạn GAP.
   */
  async reopen(user: AuthUser, id: string, dto: ReopenCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    const session = await this.findRow(user, id);

    if (session.status !== CashDrawerStatus.CLOSED) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_NOT_CLOSED,
        message: 'This drawer session is not closed',
      });
    }
    if (session.businessDate.getTime() !== businessDate().getTime()) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_REOPEN_NOT_TODAY,
        message: 'Only a drawer closed today can be reopened',
      });
    }
    await this.assertBranchAndStaff(tenantId, session.branchId, dto.staffId);
    const closedAt = session.closedAt;

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.cashDrawerSession.updateMany({
          where: {
            id,
            tenantId,
            status: CashDrawerStatus.CLOSED,
            updatedAt: session.updatedAt,
          },
          data: {
            status: CashDrawerStatus.OPEN,
            currentStaffId: dto.staffId,
            finalLogAmount: null,
            finalLogManagerId: null,
            finalLogNote: null,
            withdrawnAmount: null,
            closedAt: null,
            reopenCount: { increment: 1 },
            lastReopenedAt: new Date(),
            lastReopenedById: user.userId,
            lastReopenReason: dto.reason,
          },
        });
        if (claimed.count === 0) {
          throw new ConflictException({
            code: ErrorCode.CASH_DRAWER_CONFLICT,
            message:
              'The drawer session has just changed, please reload and try again',
          });
        }
        // Dòng sổ ghi lúc chốt nằm từ `closedAt` trở đi; dòng lúc mở két ghi lúc tạo phiên nên không bị đụng.
        if (closedAt) {
          await tx.cashFlow.deleteMany({
            where: { cashDrawerSessionId: id, createdAt: { gte: closedAt } },
          });
        }
      });
    } catch (error) {
      // Index một phần "một két OPEN mỗi chi nhánh" - không xảy ra khi chỉ mở lại phiên hôm nay, nhưng đừng thành 500.
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: ErrorCode.CASH_DRAWER_ALREADY_OPEN,
          message: 'This branch already has an open drawer session',
        });
      }
      throw error;
    }

    return this.toResponse(await this.findRow(user, id));
  }

  async finalize(user: AuthUser, id: string, dto: FinalizeCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    // Lỗi nhập liệu, kiểm trước trạng thái phiên.
    const withdrawn = dto.withdrawAmount ?? 0;
    if (withdrawn > dto.finalAmount) {
      throw new BadRequestException({
        code: ErrorCode.CASH_DRAWER_WITHDRAW_EXCEEDS_COUNT,
        message: 'The amount withdrawn cannot exceed the amount counted',
      });
    }

    const session = await this.findRow(user, id);

    if (session.status !== CashDrawerStatus.OPEN) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_CLOSED,
        message: 'This drawer session is closed',
      });
    }

    const lastLog = session.shiftLogs.at(-1);
    // Mở lại sau lần trả cuối thì lần trả đó không còn tính: người nhận két phải nhận rồi trả lại.
    const closedOut =
      lastLog?.type === ShiftLogType.END &&
      lastLog.staffId === session.currentStaffId &&
      lastLog.nextStaffId === null &&
      !reopenedAfter(session, lastLog);
    if (!closedOut) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_END_LOG_REQUIRED,
        message:
          'The cashier holding the drawer must file the final END log before it can be closed',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const closedAt = new Date();
      const claimed = await tx.cashDrawerSession.updateMany({
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
          withdrawnAmount: withdrawn,
          closedAt,
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          code: ErrorCode.CASH_DRAWER_CONFLICT,
          message:
            'The drawer session has just changed, please reload and try again',
        });
      }

      // Cùng phép tính với báo cáo đối soát, trên đúng khoảng [mở, chốt) của phiên.
      const [cash] = await this.cashBySession([{ id: session.id }], tx);
      const expected = summarizeVariance({
        openingAmount: Number(session.openingAmount),
        finalAmount: dto.finalAmount,
        cashIn: Number(cash?.cashIn ?? 0),
        cashOut: Number(cash?.cashOut ?? 0),
      }).expectedClosing;

      await bookClosing(
        tx,
        {
          tenantId,
          branchId: session.branchId,
          sessionId: session.id,
          actorId: user.userId,
        },
        {
          expectedAmount: expected,
          countedAmount: dto.finalAmount,
          withdrawnAmount: withdrawn,
          at: closedAt,
        },
      );
    });

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
  /**
   * Mỗi chi nhánh một phiên một ngày (`@@unique([tenantId, branchId, businessDate])`): đã chốt hôm nay thì không mở
   * lại được. Báo riêng thay vì để P2002 thành CASH_DRAWER_ALREADY_OPEN, vốn đọc như "két đang mở".
   */
  private async assertNotClosedToday(tenantId: string, branchId: string) {
    const closed = await this.prisma.cashDrawerSession.findFirst({
      where: {
        tenantId,
        branchId,
        businessDate: businessDate(),
        status: CashDrawerStatus.CLOSED,
      },
      select: { id: true },
    });
    if (closed) {
      throw new ConflictException({
        code: ErrorCode.CASH_DRAWER_CLOSED_TODAY,
        message: 'This branch has already closed its drawer for today',
        sessionId: closed.id,
      });
    }
  }

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
      withdrawnAmount,
      lastReopenedBy,
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
      lastReopenedBy: person(lastReopenedBy),
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
              // null ở phiên chốt trước khi có tính năng rút tiền.
              withdrawnAmount:
                withdrawnAmount === null ? null : Number(withdrawnAmount),
              keptAmount: keptAmountOf({ finalLogAmount, withdrawnAmount }),
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
