import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PayrollSettingService } from '../payroll-settings/payroll-settings.service';
import { NotificationService } from '../notifications/notifications.service';
import { PayrollNotificationTemplates } from '../notifications/templates/payroll.templates';
import { PaymentMethod } from '../../common/constants/payment-method';
import {
  generateReference,
  REFERENCE_PREFIX,
} from '../../common/utils/reference-generator';
import { paginate, skipFor } from '../../common/utils/pagination';
import { PayslipBuilderService } from './payslip-builder.service';
import type { CalculatedPayslip } from './payslip-builder.service';
import {
  dateKey,
  monthlyPeriodRange,
  PAYROLL_TRANSITIONS,
  PayrollPeriodStatus,
  vietnamToday,
} from './payroll-period.constants';
import type { PayrollAction } from './payroll-period.constants';
import {
  GeneratePayrollDto,
  PayrollActionDto,
  PreviewPayrollDto,
  QueryPayrollPeriodDto,
  UpdateDraftPayslipDto,
} from './dto/payroll-period.dto';
import type { PayrollSettings } from './payroll-math';
import type { PayrollPeriod, Prisma } from '../../../generated/prisma/client';
import { ErrorCode } from '../../common/errors/error-codes';

const PAYSLIP_USER_SELECT = {
  select: {
    id: true,
    email: true,
    phoneNumber: true,
    profileFirstName: true,
    profileLastName: true,
  },
} as const;

/** A payroll period's life: DRAFT, REVIEW, APPROVED, then PAID with a `CashFlow` row written the moment it is. The calculation half lives in `PayslipBuilderService` and `payroll-math.ts`, and the amounts are always recomputed on the server rather than taken from the client. */
@Injectable()
export class PayrollPeriodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: PayslipBuilderService,
    private readonly settings: PayrollSettingService,
    private readonly notifications: NotificationService,
  ) {}

  // ─── Preview ───────────────────────────────────────────────────────────────

  /** A what-if over an arbitrary range. Nothing is written. */
  async preview(tenantId: string, dto: PreviewPayrollDto) {
    const periodStart = new Date(
      `${dto.periodStartDate.slice(0, 10)}T00:00:00.000Z`,
    );
    const periodEnd = new Date(
      `${dto.periodEndDate.slice(0, 10)}T00:00:00.000Z`,
    );
    if (periodEnd < periodStart) {
      throw new BadRequestException({
        code: ErrorCode.DATE_RANGE_INVALID,
        message: 'periodEndDate must be on or after periodStartDate',
      });
    }
    return this.calculateAll(tenantId, dto.userIds, periodStart, periodEnd);
  }

  /** The same, for a whole month - the shape the payroll screen actually uses. */
  async previewMonth(tenantId: string, dto: GeneratePayrollDto) {
    const { periodStart, periodEnd, endKey } = monthlyPeriodRange(
      dto.payrollMonth,
    );
    this.assertPeriodHasEnded(endKey);
    return this.calculateAll(tenantId, dto.userIds, periodStart, periodEnd);
  }

  private async calculateAll(
    tenantId: string,
    userIds: string[] | undefined,
    periodStart: Date,
    periodEnd: Date,
  ) {
    const settings = this.toEngineSettings(
      await this.settings.findOne(tenantId),
    );
    const [contexts, holidayByDate] = await Promise.all([
      this.builder.gather(tenantId, userIds, periodStart, periodEnd),
      this.builder.holidaysIn(tenantId, periodStart, periodEnd),
    ]);

    const payslips: CalculatedPayslip[] = [];
    const skipped: { userId: string; reason: string }[] = [];

    for (const context of contexts) {
      const reason = this.builder.skipReason(context);
      if (reason) {
        skipped.push({ userId: context.user.id, reason });
        continue;
      }
      payslips.push(
        this.builder.calculate({
          context,
          periodStart,
          periodEnd,
          holidayByDate,
          settings,
        }),
      );
    }

    return {
      message: 'Tính bảng lương nháp thành công',
      data: {
        periodStart,
        periodEnd,
        payslips,
        skipped,
        summary: {
          totalEmployees: contexts.length,
          generatedCount: payslips.length,
          skippedCount: skipped.length,
          totalBasePay: this.sum(payslips, 'basePay'),
          totalOvertimePay: this.sum(payslips, 'overtimePay'),
          totalGrossSalary: this.sum(payslips, 'grossSalary'),
          totalNetSalary: this.sum(payslips, 'netSalary'),
        },
      },
    };
  }

  // ─── Generate ──────────────────────────────────────────────────────────────

  /** Creates the DRAFT period and its payslips, refusing while anybody is unconfigured: the preview lists who is missing a paysheet, since quietly excluding them would leave people unpaid with no flow to add them back. */
  async generate(tenantId: string, actorId: string, dto: GeneratePayrollDto) {
    const { periodStart, periodEnd, endKey, year, month } = monthlyPeriodRange(
      dto.payrollMonth,
    );
    this.assertPeriodHasEnded(endKey);

    const overlapping = await this.prisma.payrollPeriod.findFirst({
      where: {
        tenantId,
        status: { not: PayrollPeriodStatus.CANCELLED },
        periodStart: { lte: periodEnd },
        periodEnd: { gte: periodStart },
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ConflictException({
        code: ErrorCode.PAYROLL_PERIOD_OVERLAPS,
        message: 'This payroll period overlaps an existing one',
      });
    }

    const preview = await this.calculateAll(
      tenantId,
      dto.userIds,
      periodStart,
      periodEnd,
    );
    if (preview.data.payslips.length === 0) {
      throw new HttpException(
        {
          code: ErrorCode.PAYROLL_NO_ELIGIBLE_PAYSLIP,
          message: 'There is no valid payslip to build a payroll period from',
          errors: { skipped: preview.data.skipped },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (preview.data.skipped.length > 0) {
      throw new HttpException(
        {
          code: ErrorCode.PAYROLL_STAFF_UNCONFIGURED,
          message:
            'The payroll period cannot be created while employees are missing configuration',
          errors: { skipped: preview.data.skipped },
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      const period = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payrollPeriod.create({
          data: {
            tenantId,
            name: `Kỳ lương ${String(month).padStart(2, '0')}/${year}`,
            periodStart,
            periodEnd,
            status: PayrollPeriodStatus.DRAFT,
            generatedById: actorId,
          },
        });

        for (const payslip of preview.data.payslips) {
          await tx.payslip.create({
            data: {
              tenantId,
              userId: payslip.userId,
              payrollPeriodId: created.id,
              paysheetId: payslip.paysheetId,
              manageById: actorId,
              status: PayrollPeriodStatus.DRAFT,
              periodStart,
              periodEnd,
              totalWorkedDays: payslip.totalWorkedDays,
              totalWorkedHours: payslip.totalWorkedHours,
              basePay: payslip.basePay,
              overtimePay: payslip.overtimePay,
              paidLeaveDays: payslip.paidLeaveDays,
              unpaidLeaveDays: payslip.unpaidLeaveDays,
              paidLeavePay: payslip.paidLeavePay,
              unpaidLeaveDeduction: payslip.unpaidLeaveDeduction,
              bonus: payslip.bonus,
              allowance: payslip.allowance,
              grossSalary: payslip.grossSalary,
              deduction: payslip.deduction,
              netSalary: payslip.netSalary,
              allowanceLines: { create: payslip.allowanceLines },
              bonusLines: { create: payslip.bonusLines },
              deductionLines: { create: payslip.deductionLines },
              leaveLines: {
                create: payslip.leaveLines.map((line) => ({
                  leaveRequestId: line.leaveRequestId,
                  paidDays: line.paidDays,
                  unpaidDays: line.unpaidDays,
                  paidAmount: line.paidAmount,
                  deductedAmount: line.deductedAmount,
                  dates: { create: line.dates },
                })),
              },
            },
          });
        }

        return created;
      });

      return {
        message: 'Tạo kỳ lương nháp thành công',
        data: {
          payrollPeriod: period,
          summary: preview.data.summary,
          skipped: preview.data.skipped,
        },
      };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({
          code: ErrorCode.PAYROLL_PERIOD_EXISTS,
          message: 'This payroll period already exists',
        });
      }
      throw error;
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async findAll(tenantId: string, query: QueryPayrollPeriodDto) {
    const where: Prisma.PayrollPeriodWhereInput = { tenantId };
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      this.prisma.payrollPeriod.findMany({
        where,
        orderBy: { periodStart: 'desc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.payrollPeriod.count({ where }),
    ]);

    const [costs, stale] = await Promise.all([
      this.totalCostByPeriod(
        tenantId,
        rows.map((row) => row.id),
      ),
      this.staleDraftPeriods(tenantId, rows),
    ]);

    return paginate(
      rows.map((row) => ({
        ...row,
        totalCost: costs.get(row.id) ?? 0,
        needsRecalculation: stale.has(row.id),
        attendanceChangedAt: stale.get(row.id) ?? null,
      })),
      total,
      query.page,
      query.limit,
    );
  }

  async findOne(tenantId: string, id: string, query: QueryPayrollPeriodDto) {
    const period = await this.findRow(tenantId, id);

    const where: Prisma.PayslipWhereInput = { tenantId, payrollPeriodId: id };
    const [payslips, total, costs, stale] = await Promise.all([
      this.prisma.payslip.findMany({
        where,
        include: { user: PAYSLIP_USER_SELECT },
        orderBy: { createdAt: 'asc' },
        skip: skipFor(query.page, query.limit),
        take: query.limit,
      }),
      this.prisma.payslip.count({ where }),
      this.totalCostByPeriod(tenantId, [id]),
      this.staleDraftPeriods(tenantId, [period]),
    ]);

    return {
      payrollPeriod: {
        ...period,
        // The period's whole cost, never the page's - a total that changed with `limit` would be read as the payroll shrinking.
        totalCost: costs.get(id) ?? 0,
        needsRecalculation: stale.has(id),
        attendanceChangedAt: stale.get(id) ?? null,
      },
      ...paginate(
        payslips.map((row) => this.toPayslipResponse(row)),
        total,
        query.page,
        query.limit,
      ),
    };
  }

  async findPayslip(tenantId: string, periodId: string, payslipId: string) {
    const payslip = await this.prisma.payslip.findFirst({
      where: { id: payslipId, payrollPeriodId: periodId, tenantId },
      include: {
        user: PAYSLIP_USER_SELECT,
        allowanceLines: true,
        bonusLines: true,
        deductionLines: true,
        leaveLines: { include: { dates: true } },
        manualAdjustments: true,
      },
    });
    if (!payslip)
      throw new NotFoundException({
        code: ErrorCode.PAYSLIP_NOT_FOUND,
        message: 'Payslip not found',
      });
    return this.toPayslipResponse(payslip);
  }

  // ─── Draft editing ─────────────────────────────────────────────────────────

  /** Adds one-off adjustments to a draft payslip and re-totals it. DRAFT only, because REVIEW exists so an employee can check figures that aren't moving underneath them; re-totalled from the stored components so editing twice can't compound. */
  async updateDraftPayslip(
    tenantId: string,
    actorId: string,
    periodId: string,
    payslipId: string,
    dto: UpdateDraftPayslipDto,
  ) {
    if (dto.note === undefined && dto.manualAdjustments === undefined) {
      throw new BadRequestException({
        code: ErrorCode.PAYSLIP_UPDATE_EMPTY,
        message: 'Either note or manualAdjustments must be provided',
      });
    }
    if (dto.manualAdjustments?.some((item) => item.amount === 0)) {
      throw new BadRequestException({
        code: ErrorCode.PAYSLIP_ADJUSTMENT_ZERO,
        message: 'An adjustment amount cannot be 0',
      });
    }

    const period = await this.findRow(tenantId, periodId);
    if (period.status !== PayrollPeriodStatus.DRAFT) {
      throw new ConflictException({
        code: ErrorCode.PAYROLL_PERIOD_NOT_DRAFT,
        message:
          'A payslip can only be edited while its payroll period is a DRAFT',
      });
    }

    const payslip = await this.prisma.payslip.findFirst({
      where: { id: payslipId, payrollPeriodId: periodId, tenantId },
      include: { manualAdjustments: true },
    });
    if (!payslip) {
      throw new NotFoundException({
        code: ErrorCode.PAYSLIP_NOT_IN_PERIOD,
        message: 'Payslip not found in this period',
      });
    }

    const adjustments =
      dto.manualAdjustments ??
      payslip.manualAdjustments.map((item) => ({
        category: item.category,
        name: item.name,
        amount: Number(item.amount),
        note: item.note ?? undefined,
      }));
    const adjustmentTotal = adjustments.reduce(
      (total, item) => total + item.amount,
      0,
    );

    const netSalary =
      Number(payslip.grossSalary ?? 0) +
      Number(payslip.bonus) +
      Number(payslip.allowance) -
      Number(payslip.deduction) +
      adjustmentTotal;
    if (netSalary < 0) {
      throw new HttpException(
        {
          code: ErrorCode.PAYSLIP_NET_NEGATIVE,
          message: 'The adjustments take net pay below 0',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.manualAdjustments !== undefined) {
        await tx.payslipManualAdjustment.deleteMany({
          where: { payslipId },
        });
      }
      return tx.payslip.update({
        where: { id: payslipId },
        data: {
          note: dto.note,
          netSalary,
          manageById: actorId,
          ...(dto.manualAdjustments !== undefined
            ? {
                manualAdjustments: {
                  create: dto.manualAdjustments.map((item) => ({
                    category: item.category ?? 'OTHER',
                    name: item.name,
                    amount: item.amount,
                    note: item.note,
                    createdById: actorId,
                  })),
                },
              }
            : {}),
        },
        include: {
          user: PAYSLIP_USER_SELECT,
          manualAdjustments: true,
        },
      });
    });

    return {
      payslip: this.toPayslipResponse(updated),
      manualAdjustmentTotal: adjustmentTotal,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /** Moves a period along - five actions, each valid from exactly one state. `MARK_PAID` writes the `CashFlow` expense row and flips the status in one transaction, so a period can never read as paid without the ledger entry proving it. */
  async changeStatus(
    tenantId: string,
    actorId: string,
    periodId: string,
    action: PayrollAction,
    dto: PayrollActionDto,
  ) {
    const transition = PAYROLL_TRANSITIONS[action];
    if ((action === 'CANCEL' || action === 'RETURN_TO_DRAFT') && !dto.reason) {
      throw new BadRequestException({
        code: ErrorCode.PAYROLL_ACTION_REASON_REQUIRED,
        message:
          action === 'CANCEL'
            ? 'A reason is required to cancel a payroll period'
            : 'A reason is required to return a payroll period to draft',
      });
    }

    const period = await this.findRow(tenantId, periodId);
    if (period.status !== transition.from) {
      throw new ConflictException({
        code: ErrorCode.PAYROLL_ACTION_STATUS_INVALID,
        message: `${action} is only allowed while the payroll period is ${transition.from}`,
      });
    }

    if (action === 'SUBMIT') {
      // Attendance edited since the draft was built means its numbers are already wrong, and there is no partial recalculation - so the honest answer is "cancel and regenerate".
      const stale = await this.staleDraftPeriods(tenantId, [period]);
      if (stale.has(period.id)) {
        throw new ConflictException({
          code: ErrorCode.PAYROLL_ATTENDANCE_STALE,
          message:
            'Attendance has changed since this payroll period was built. Cancel it and generate it again before submitting.',
        });
      }
      const payslipCount = await this.prisma.payslip.count({
        where: { tenantId, payrollPeriodId: periodId },
      });
      if (payslipCount === 0) {
        throw new HttpException(
          {
            code: ErrorCode.PAYROLL_PERIOD_EMPTY,
            message: 'This payroll period has no payslip to submit',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }

    const now = new Date();
    const stamps: Prisma.PayrollPeriodUpdateInput = {
      status: transition.to,
    };
    if (action === 'SUBMIT') {
      stamps.submittedBy = { connect: { id: actorId } };
      stamps.submittedAt = now;
    } else if (action === 'CANCEL') {
      stamps.cancelledBy = { connect: { id: actorId } };
      stamps.cancelledAt = now;
      stamps.cancelReason = dto.reason;
    } else if (action === 'RETURN_TO_DRAFT') {
      stamps.returnedBy = { connect: { id: actorId } };
      stamps.returnedAt = now;
      stamps.returnReason = dto.reason;
    } else if (action === 'APPROVE') {
      stamps.approvedBy = { connect: { id: actorId } };
      stamps.approvedAt = now;
    } else {
      stamps.paidBy = { connect: { id: actorId } };
      stamps.paidAt = now;
      // Server-owned. See PayrollActionDto for why the client may not name a method.
      stamps.paymentMethod = PaymentMethod.CASH;
      stamps.paymentReference = dto.paymentReference;
      stamps.paymentNote = dto.paymentNote;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (action === 'MARK_PAID') {
          // Re-read inside the transaction: the total from a list or detail response is another request's answer and may already be stale.
          const totals = await tx.payslip.aggregate({
            where: { tenantId, payrollPeriodId: periodId },
            _sum: { netSalary: true },
          });
          const totalCost = Number(totals._sum.netSalary ?? 0);
          if (totalCost <= 0) {
            throw new HttpException(
              {
                code: ErrorCode.PAYROLL_TOTAL_ZERO,
                message: 'A payroll period with a total of 0 cannot be paid',
              },
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }

          const reference = generateReference(REFERENCE_PREFIX.PAYROLL);
          const cashFlow = await tx.cashFlow.create({
            data: {
              tenantId,
              payrollPeriodId: periodId,
              createdById: actorId,
              flowType: 'EXPENSE',
              amount: totalCost,
              paymentMethod: PaymentMethod.CASH,
              paymentReference: reference,
              description: `Thanh toán ${period.name}`,
            },
          });
          // The relation is the real link; the reference is snapshotted so a screen can show the PAYR code without a second read.
          stamps.cashFlow = { connect: { id: cashFlow.id } };
          stamps.cashFlowReference = reference;
        }

        await tx.payrollPeriod.update({
          where: { id: periodId },
          data: stamps,
        });
        // A payslip's status always mirrors its period's - there is no per-payslip workflow, and the employee-visible filter reads it.
        await tx.payslip.updateMany({
          where: { tenantId, payrollPeriodId: periodId },
          data: { status: transition.to },
        });
      });
    } catch (error) {
      if (action === 'MARK_PAID' && this.isUniqueViolation(error)) {
        // `CashFlow.payrollPeriodId` is unique: one period, one expense row, even when two requests race.
        throw new ConflictException({
          code: ErrorCode.PAYROLL_CASHFLOW_EXISTS,
          message:
            'The CashFlow entry for this payroll period has already been recorded',
        });
      }
      throw error;
    }

    await this.announce(tenantId, periodId, action);
    return this.findRow(tenantId, periodId);
  }

  /** Tells each employee their payslip moved. Only three actions notify - RETURN_TO_DRAFT and CANCEL send the period somewhere employees can't see - and re-submitting after an edit notifies again, because the figures changed. */
  private async announce(
    tenantId: string,
    periodId: string,
    action: PayrollAction,
  ) {
    const content = PayrollNotificationTemplates.forAction(action);
    if (!content) return;

    const payslips = await this.prisma.payslip.findMany({
      where: { tenantId, payrollPeriodId: periodId },
      select: { id: true, userId: true },
    });
    for (const payslip of payslips) {
      await this.notifications.notify({
        tenantId,
        recipientIds: [payslip.userId],
        referenceId: payslip.id,
        ...content(payslip.id),
      });
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async findRow(tenantId: string, id: string): Promise<PayrollPeriod> {
    const period = await this.prisma.payrollPeriod.findFirst({
      where: { id, tenantId },
    });
    if (!period)
      throw new NotFoundException({
        code: ErrorCode.PAYROLL_PERIOD_NOT_FOUND,
        message: 'Payroll period not found',
      });
    return period;
  }

  /** A period can only be generated once it is over - you cannot pay for days not worked. */
  private assertPeriodHasEnded(endKey: string) {
    if (endKey >= vietnamToday()) {
      throw new HttpException(
        {
          code: ErrorCode.PAYROLL_PERIOD_NOT_ENDED,
          message: 'A payroll run is only possible once the period has ended',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /** Summed on the server, never by adding up a paginated page of payslips. */
  private async totalCostByPeriod(
    tenantId: string,
    periodIds: string[],
  ): Promise<Map<string, number>> {
    if (periodIds.length === 0) return new Map();
    const rows = await this.prisma.payslip.groupBy({
      by: ['payrollPeriodId'],
      where: { tenantId, payrollPeriodId: { in: periodIds } },
      _sum: { netSalary: true },
    });
    return new Map(
      rows
        .filter((row) => row.payrollPeriodId !== null)
        .map((row) => [row.payrollPeriodId!, Number(row._sum.netSalary ?? 0)]),
    );
  }

  /** Which DRAFT periods have had attendance edited underneath them, in one query rather than the old service's one per period. Only DRAFT periods can go stale: after submission the attendance is frozen. */
  private async staleDraftPeriods(
    tenantId: string,
    periods: {
      id: string;
      status: string;
      periodStart: Date;
      periodEnd: Date;
      createdAt: Date;
    }[],
  ): Promise<Map<string, Date>> {
    const drafts = periods.filter(
      (period) => period.status === PayrollPeriodStatus.DRAFT,
    );
    if (drafts.length === 0) return new Map();

    const edited = await this.prisma.attendance.findMany({
      where: {
        tenantId,
        OR: drafts.map((period) => ({
          workDate: { gte: period.periodStart, lte: period.periodEnd },
          updatedAt: { gt: period.createdAt },
        })),
      },
      select: { workDate: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    const stale = new Map<string, Date>();
    for (const period of drafts) {
      const hit = edited.find(
        (row) =>
          row.workDate >= period.periodStart &&
          row.workDate <= period.periodEnd &&
          row.updatedAt > period.createdAt,
      );
      if (hit) stale.set(period.id, hit.updatedAt);
    }
    return stale;
  }

  private toEngineSettings(setting: {
    standardWorkingDays: number;
    standardWorkingHoursPerDay: number;
    weekendDays: number[];
    lateGraceMinutes: number;
  }): PayrollSettings {
    return {
      standardWorkingDays: setting.standardWorkingDays,
      standardWorkingHoursPerDay: setting.standardWorkingHoursPerDay,
      weekendDays: setting.weekendDays,
      lateGraceMinutes: setting.lateGraceMinutes,
    };
  }

  private sum(payslips: CalculatedPayslip[], key: keyof CalculatedPayslip) {
    return payslips.reduce((total, slip) => total + Number(slip[key]), 0);
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  /** Decimals become numbers - every one of these is displayed as money. */
  toPayslipResponse<T extends Record<string, unknown>>(payslip: T): T {
    const money = [
      'totalWorkedDays',
      'totalWorkedHours',
      'basePay',
      'overtimePay',
      'paidLeaveDays',
      'unpaidLeaveDays',
      'paidLeavePay',
      'unpaidLeaveDeduction',
      'bonus',
      'allowance',
      'grossSalary',
      'deduction',
      'netSalary',
    ];
    const shaped: Record<string, unknown> = { ...payslip };
    for (const key of money) {
      if (shaped[key] !== null && shaped[key] !== undefined) {
        shaped[key] = Number(shaped[key]);
      }
    }
    return shaped as T;
  }
}

/** `dateKey` is re-exported so the controller can format a period without importing twice. */
export { dateKey };
