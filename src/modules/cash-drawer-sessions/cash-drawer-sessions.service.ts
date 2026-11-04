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

const SESSION_INCLUDE = {
  branch: BRANCH_NAME_SELECT,
  openedBy: { select: STAFF_SELECT },
  currentStaff: { select: STAFF_SELECT },
  finalLogManager: { select: STAFF_SELECT },
  shiftLogs: {
    // `id` chỉ để phá thế hoà khi hai log cách nhau một micro-giây vẫn trả về theo thứ tự ổn định; thứ thực sự chặn trùng là guard trong submitShiftLog.
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
} as const satisfies Prisma.CashDrawerSessionSelect;

type VarianceRow = Prisma.CashDrawerSessionGetPayload<{
  select: typeof VARIANCE_SELECT;
}>;

interface CashDayRow {
  branchId: string;
  day: string;
  cashIn: Prisma.Decimal;
  cashOut: Prisma.Decimal;
  movementCount: number;
}

const DEFAULT_REPORT_DAYS = 30;
/** Một năm và một ngày: báo cáo tải mọi phiên trong khoảng trước khi phân trang, nên tổng phản ánh cả khoảng chứ không phải trang hiện tại; đánh đổi đó cần một trần. */
const MAX_REPORT_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Két của một chi nhánh trong một ngày: mở với số đã đếm, chuyển giữa thu ngân qua shift log, chốt một lần. Unique index ép một phiên mỗi chi nhánh mỗi ngày và tối đa một phiên OPEN. Chi nhánh lấy từ nơi tài khoản được gán; `cash_drawers:read` hay `read_own` quyết định thấy bao nhiêu. */
@Injectable()
export class CashDrawerSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async open(user: AuthUser, dto: OpenCashDrawerDto) {
    const tenantId = this.tenantOf(user);
    // required = true nên ở đây không bao giờ null.
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
      // Cả hai bất biến đều có thể là cái bị kích hoạt (két đã mở, hoặc phiên hôm nay đã đóng), và tại quầy cả hai đều có nghĩa như nhau.
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

    // Danh sách cũ bỏ shiftLogs cho gọn payload; phần tóm tắt giữ ý hữu ích (bao nhiêu ca, ai đang giữ) mà không kèm toàn bộ lịch sử.
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

  /** Tiền mặt lẽ ra phải có so với số đã đếm, chia theo ca. Chỉ tính tiền mặt: thẻ và SePay không vào két, doanh thu không tiền mặt chỉ để làm ngữ cảnh, không nằm trong chênh lệch. */
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
          // `NOT` chứ không phải `paymentMethod: { not: 'CASH' }` - cột này nullable và `not` của Prisma bỏ qua NULL, nên phương thức chưa ghi sẽ không được báo ở đâu.
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
      // Thời điểm chính xác mà tổng bao phủ, để tranh cãi về biên lai gần nửa đêm có thể được giải quyết bằng cách xem lại.
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

  /** Cùng phép trừ trên khoảng nhiều ngày: hai query bất kể khoảng nào, rồi lọc và phân trang trên bộ nhớ, để `varianceOnly` và tổng phản ánh cả khoảng chứ không chỉ một trang. */
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

  /** Thu chi tiền mặt theo chi nhánh theo ngày giao dịch, nhóm bằng `AT TIME ZONE` trong Postgres để giao dịch 23:30 không bị xếp sang ngày mai; điều kiện `created_at` giữ là khoảng thường để index vẫn dùng được. */
  private async cashByBusinessDay(
    tenantId: string,
    branchId: string | null,
    fromDate: Date,
    toDate: Date,
  ): Promise<Map<string, CashDayRow>> {
    const start = businessDayRange(fromDate).start;
    const end = businessDayRange(toDate).end;

    const rows = await this.prisma.$queryRaw<CashDayRow[]>`
      SELECT c.location_id AS "branchId",
             to_char(created_at AT TIME ZONE ${BUSINESS_TIMEZONE}, 'YYYY-MM-DD') AS "day",
             COALESCE(SUM(CASE WHEN flow_type = ${FlowType.INCOME} THEN amount ELSE 0 END), 0) AS "cashIn",
             COALESCE(SUM(CASE WHEN flow_type <> ${FlowType.INCOME} THEN amount ELSE 0 END), 0) AS "cashOut",
             COUNT(*)::int AS "movementCount"
      FROM cash_flows c
      -- Only flows booked at a branch: a warehouse's cash is not in any drawer.
      JOIN branches b ON b.id = c.location_id
      WHERE c.tenant_id = ${tenantId}
        AND c.payment_method = ${PaymentMethod.CASH}
        AND c.created_at >= ${start}
        AND c.created_at < ${end}
        ${branchId ? Prisma.sql`AND c.location_id = ${branchId}` : Prisma.empty}
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
      branch: namedBranch(session.branch),
      businessDate: session.businessDate,
      status: session.status,
      movementCount: day?.movementCount ?? 0,
      ...summary,
    };
  }

  private reportTotals(rows: { variance: number | null }[]) {
    // Phiên chưa ai đóng không có tổng đếm nên không được coi là khớp hay lệch; đếm riêng, không cộng vào tổng nào.
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

  /** Dòng tiền thuộc một ngày giao dịch của một chi nhánh. `branchId` bắt buộc, nên chi EXPENSE không gắn chi nhánh (trả nhà cung cấp bằng tiền mặt) không được tính; shop trả NCC từ két thì ngày đó sẽ thiếu, và điều đó là đúng. */
  private dayFlowWhere(
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

  /** Ghi nhận thu ngân nhận két hoặc trả lại. Thứ tự được kiểm chứ không giả định: START chỉ mở phiên hoặc nối sau một END đã chỉ định người này, vì nếu không thì thiếu hụt sẽ không quy được trách nhiệm. */
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

    // Ai giữ két sau khi log này được ghi; ghi vô điều kiện, và điều này là then chốt (xem bên dưới).
    const nextHolder = dto.nextStaffId ?? user.userId;

    await this.prisma.$transaction(async (tx) => {
      // Điều kiện theo trạng thái đã đọc, và `data` không bao giờ được rỗng: `updateMany({ data: {} })` khớp dòng nhưng không đụng `@updatedAt`, nên bấm đúp hoặc client retry sẽ insert hai lần. iKiotMS-BE có được điều này miễn phí nhờ `$push` trên mảng nhúng.
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

  /** Chốt ngày với tổng đã đếm. Bị từ chối trừ khi log cuối là `END` của người đang giữ két và không chỉ định ai nhận; log đó là bàn giao cho quản lý. */
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

  private tenantOf(user: AuthUser): string {
    if (!user.tenantId) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_HAS_NO_TENANT,
        message: 'This account does not belong to any shop',
      });
    }
    return user.tenantId;
  }

  /** Két của chi nhánh nào đang được gọi tới, hoặc `null` nếu là mọi chi nhánh. Có phân công thì phân công thắng (chỉ định chi nhánh khác là 403); owner được chỉ định một chi nhánh; ai không có phân công thì bị từ chối thay vì rơi vào "không lọc". Không bao giờ là `''`, vì nó sẽ thành id thật trong `where`. */
  private resolveBranch(
    user: AuthUser,
    requested: string | undefined,
    required = true,
  ): string | null {
    if (user.branchId) {
      // Trưởng ca đến được chi nhánh mà ca đang làm bao phủ. Đã giao với phân công của họ, nhưng vẫn kiểm để quy tắc đọc giống với stock movements.
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

  /** Tài khoản này thấy mọi phiên của chi nhánh (`cash_drawers:read`) hay chỉ những phiên chính họ làm (`read_own`). */
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

  /** Chi nhánh phải đang hoạt động và thu ngân phải thực sự làm việc tại đó; đây là phần còn lại của kiểm tra cũ sau khi bỏ kiểm tra role họ STAFF. */
  private async assertBranchAndStaff(
    tenantId: string,
    branchId: string,
    staffId: string,
  ) {
    const [branch, staff] = await Promise.all([
      this.prisma.branch.findFirst({
        where: {
          id: branchId,
          tenantId,
          location: { status: LocationStatus.ACTIVE },
        },
        select: { id: true },
      }),
      this.prisma.user.findFirst({
        where: {
          id: staffId,
          tenantId,
          locationId: branchId,
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
    // Người dùng trả về với `profile` lồng nhau như mọi payload user khác, để màn hình in được tên thay vì nhãn chung.
    const person = <T extends FlatUserProfile | null>(row: T) =>
      row ? withNestedProfile(row) : row;

    return {
      ...rest,
      branch: namedBranch(rest.branch),
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
