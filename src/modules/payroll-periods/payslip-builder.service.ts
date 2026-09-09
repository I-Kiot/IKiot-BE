import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaysheetService } from '../paysheets/paysheets.service';
import { SystemRole } from '../../common/constants/system-role';
import { UserStatus } from '../../common/constants/user-status';
import { ScheduleStatus } from '../working-schedules/working-schedule.constants';
import { LeaveRequestStatus } from '../leave-requests/leave-request.constants';
import { dateKey } from './payroll-period.constants';
import { Prisma } from '../../../generated/prisma/client';
import { businessDayRange } from '../cash-drawer-sessions/business-date';
import { OrderStatus } from '../orders/order.constants';
import {
  allocateLeaveDays,
  dateKeyOf,
  fixedWorkedPay,
  deductionUnits,
  isSupportedDeduction,
  NO_REVENUE,
  paidLeaveDayAmount,
  payBonuses,
  payForSchedules,
  PayType,
  ScheduleKind,
  scheduleEarlyLeaveMinutes,
  scheduleLateInfo,
  toPayableSchedules,
  unpaidLeaveDayDeduction,
  workedDayCount,
} from './payroll-math';
import type {
  AttendanceSpan,
  BonusLine,
  BonusRule,
  PayrollHoliday,
  PayrollSettings,
  PaysheetRates,
  RevenueFigures,
  SchedulePeriod,
} from './payroll-math';

/** Everything one employee's payslip is computed from. */
export interface PayrollContext {
  user: {
    id: string;
    email: string | null;
    phoneNumber: string;
    profileFirstName: string | null;
    profileLastName: string | null;
    paysheetId: string | null;
    /** Which branch's takings a BRANCH_REVENUE bonus means. Null for warehouse or unposted staff. */
    branchId: string | null;
  };
  rates: PaysheetRates | null;
  paysheetId: string | null;
  allowances: {
    name: string;
    enable: boolean;
    amountType: string | null;
    amountValue: number;
  }[];
  deductions: {
    name: string;
    enable: boolean;
    deductionType: string;
    conditionType: string | null;
    blockMinutes: number | null;
    deductionValue: number;
  }[];
  bonuses: BonusRule[];
  /** The period's takings, measured two ways: what this person rang up, and what their branch did. */
  revenue: { employee: RevenueFigures; branch: RevenueFigures };
  schedules: SchedulePeriod[];
  attendances: AttendanceSpan[];
  leaveRequests: {
    id: string;
    startDate: Date;
    endDate: Date;
    paidLeaveDays: number;
    unpaidLeaveDays: number;
  }[];
}

export interface CalculatedPayslip {
  userId: string;
  paysheetId: string;
  totalWorkedDays: number;
  totalWorkedHours: number;
  basePay: number;
  overtimePay: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  paidLeavePay: number;
  unpaidLeaveDeduction: number;
  bonus: number;
  allowance: number;
  grossSalary: number;
  deduction: number;
  netSalary: number;
  allowanceLines: {
    name: string;
    amountType: string;
    amountValue: number;
    amount: number;
  }[];
  bonusLines: BonusLine[];
  deductionLines: {
    name: string;
    deductionType: string;
    conditionType: string | null;
    blockMinutes: number | null;
    deductionValue: number;
    violationMinutes: number;
    units: number;
    amount: number;
  }[];
  leaveLines: {
    leaveRequestId: string;
    paidDays: number;
    unpaidDays: number;
    paidAmount: number;
    deductedAmount: number;
    dates: {
      date: Date;
      leaveType: string;
      dayFraction: number;
      amount: number;
      ignoredBecauseAttended: boolean;
    }[];
  }[];
  calculationWarnings: string[];
  lines: ReturnType<typeof payForSchedules>['lines'];
}

/** Loads what payroll needs and turns it into payslips, using `payroll-math.ts` for every decision about money - the reading-and-computing half, kept apart from the lifecycle half that the old 1500-line `PayrollService` mixed in. */
@Injectable()
export class PayslipBuilderService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything every employee's payslip needs, in as few queries as the shape allows. Owners and admins are excluded: they aren't on a paysheet and don't draw a wage through payroll. */
  async gather(
    tenantId: string,
    userIds: string[] | undefined,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<PayrollContext[]> {
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        status: UserStatus.ACTIVE,
        systemRole: SystemRole.STAFF,
        ...(userIds?.length ? { id: { in: userIds } } : {}),
      },
      select: {
        id: true,
        email: true,
        phoneNumber: true,
        profileFirstName: true,
        profileLastName: true,
        paysheetId: true,
        branchId: true,
      },
    });
    if (users.length === 0) return [];

    const targetIds = users.map((user) => user.id);
    const paysheetIds = [
      ...new Set(
        users.map((user) => user.paysheetId).filter((id) => id !== null),
      ),
    ];

    const [paysheets, attendances, leaveRequests, revenue] = await Promise.all([
      this.prisma.paysheet.findMany({
        where: {
          id: { in: paysheetIds },
          tenantId,
          status: { not: 'DELETED' },
        },
        include: {
          allowances: true,
          deductions: true,
          // Tiers in the order the owner arranged them - `tierFor` breaks a threshold tie on `position`, so the order has to be the stored one.
          bonuses: { include: { tiers: { orderBy: { position: 'asc' } } } },
        },
      }),
      this.prisma.attendance.findMany({
        where: {
          tenantId,
          userId: { in: targetIds },
          workDate: { gte: periodStart, lte: periodEnd },
        },
        select: {
          userId: true,
          scheduleId: true,
          actualCheckinAt: true,
          actualCheckoutAt: true,
          lateMinutes: true,
        },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          tenantId,
          userId: { in: targetIds },
          status: LeaveRequestStatus.APPROVED,
          startDate: { lte: periodEnd },
          endDate: { gte: periodStart },
        },
        select: {
          id: true,
          userId: true,
          startDate: true,
          endDate: true,
          paidLeaveDays: true,
          unpaidLeaveDays: true,
        },
      }),
      this.revenueIn(tenantId, periodStart, periodEnd),
    ]);

    // Schedules are loaded across the whole span of every leave request, not just the period: a request straddling two periods must spend its paid days once, or the allocation restarts and pays them twice.
    let rangeStart = periodStart;
    let rangeEnd = periodEnd;
    for (const request of leaveRequests) {
      if (request.startDate && request.startDate < rangeStart) {
        rangeStart = request.startDate;
      }
      if (request.endDate && request.endDate > rangeEnd) {
        rangeEnd = request.endDate;
      }
    }

    const schedules = await this.prisma.workingSchedule.findMany({
      where: {
        tenantId,
        status: {
          notIn: [ScheduleStatus.CANCELLED, ScheduleStatus.DELETED],
        },
        workDate: { gte: rangeStart, lte: rangeEnd },
        assignedUsers: { some: { userId: { in: targetIds } } },
      },
      select: {
        id: true,
        scheduleType: true,
        workDate: true,
        startAt: true,
        endAt: true,
        assignedUsers: { select: { userId: true } },
      },
    });

    const paysheetById = new Map(paysheets.map((sheet) => [sheet.id, sheet]));
    const byUser = <T extends { userId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const list = map.get(row.userId) ?? [];
        list.push(row);
        map.set(row.userId, list);
      }
      return map;
    };
    const attendanceByUser = byUser(attendances);
    const leaveByUser = byUser(leaveRequests);

    const scheduleByUser = new Map<string, SchedulePeriod[]>();
    for (const schedule of schedules) {
      if (!schedule.workDate || !schedule.startAt || !schedule.endAt) continue;
      const shaped: SchedulePeriod = {
        id: schedule.id,
        scheduleType: schedule.scheduleType,
        workDate: dateKey(schedule.workDate),
        startAt: schedule.startAt,
        endAt: schedule.endAt,
      };
      for (const { userId } of schedule.assignedUsers) {
        const list = scheduleByUser.get(userId) ?? [];
        list.push(shaped);
        scheduleByUser.set(userId, list);
      }
    }

    return users.map((user) => {
      const paysheet = user.paysheetId
        ? (paysheetById.get(user.paysheetId) ?? null)
        : null;

      return {
        user,
        paysheetId: paysheet?.id ?? null,
        rates: paysheet ? PaysheetService.ratesOf(paysheet) : null,
        allowances: (paysheet?.allowances ?? []).map((item) => ({
          name: item.name ?? '',
          enable: item.enable,
          amountType: item.amountType,
          amountValue: Number(item.amountValue ?? 0),
        })),
        bonuses: (paysheet?.bonuses ?? []).map((item) => ({
          bonusType: item.bonusType,
          calculationType: item.calculationType,
          enable: item.enable,
          tiers: item.tiers.map((tier) => ({
            name: tier.name,
            fromValue: tier.fromValue === null ? null : Number(tier.fromValue),
            rewardType: tier.rewardType,
            rewardValue:
              tier.rewardValue === null ? null : Number(tier.rewardValue),
            position: tier.position,
          })),
        })),
        revenue: {
          employee: revenue.byUser.get(user.id) ?? { ...NO_REVENUE },
          branch: user.branchId
            ? (revenue.byBranch.get(user.branchId) ?? { ...NO_REVENUE })
            : { ...NO_REVENUE },
        },
        deductions: (paysheet?.deductions ?? []).map((item) => ({
          name: item.name,
          enable: item.enable,
          deductionType: item.deductionType,
          conditionType: item.conditionType,
          blockMinutes: item.blockMinutes,
          deductionValue: Number(item.deductionValue),
        })),
        schedules: scheduleByUser.get(user.id) ?? [],
        attendances: (attendanceByUser.get(user.id) ?? []).map((row) => ({
          scheduleId: row.scheduleId,
          actualCheckinAt: row.actualCheckinAt,
          actualCheckoutAt: row.actualCheckoutAt,
          lateMinutes: row.lateMinutes,
        })),
        leaveRequests: (leaveByUser.get(user.id) ?? [])
          .filter((row) => row.startDate && row.endDate)
          .map((row) => ({
            id: row.id,
            startDate: row.startDate!,
            endDate: row.endDate!,
            paidLeaveDays: Number(row.paidLeaveDays),
            unpaidLeaveDays: Number(row.unpaidLeaveDays),
          })),
      };
    });
  }

  /** The period's takings per (cashier, branch) in the three flavours a bonus rule can name, grouped by both keys in one pass and deliberately not filtered to the payroll targets, since a branch's revenue is everyone's sales there. The window is the shop's local days via `businessDayRange`; three queries rather than one, because joining `order_items` would count an order once per line. */
  async revenueIn(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{
    byUser: Map<string, RevenueFigures>;
    byBranch: Map<string, RevenueFigures>;
  }> {
    const start = businessDayRange(periodStart).start;
    const end = businessDayRange(periodEnd).end;

    interface RevenueRow {
      userId: string;
      branchId: string;
      amount: Prisma.Decimal;
    }

    const [gross, net, collected] = await Promise.all([
      // Before discount: what the price tags added up to.
      this.prisma.$queryRaw<RevenueRow[]>`
        SELECT o.user_id AS "userId", o.branch_id AS "branchId",
               COALESCE(SUM(oi.unit_price * oi.quantity), 0) AS "amount"
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.tenant_id = ${tenantId}
          AND o.status = ${OrderStatus.COMPLETED}
          AND o.created_at >= ${start}
          AND o.created_at < ${end}
        GROUP BY 1, 2
      `,
      // After discount. A returned sale carries status RETURNED, so it is already excluded rather than subtracted - the same figure with one fewer place to double-count.
      this.prisma.$queryRaw<RevenueRow[]>`
        SELECT user_id AS "userId", branch_id AS "branchId",
               COALESCE(SUM(grand_total), 0) AS "amount"
        FROM orders
        WHERE tenant_id = ${tenantId}
          AND status = ${OrderStatus.COMPLETED}
          AND created_at >= ${start}
          AND created_at < ${end}
        GROUP BY 1, 2
      `,
      // Cash basis, dated by when the money moved, so a SePay order settled on the 1st belongs to the new period. It sums `o.grand_total`, not `c.amount`: a cash sale writes a separate EXPENSE for the change, and summing ledger amounts would credit the cashier with the change they gave back.
      this.prisma.$queryRaw<RevenueRow[]>`
        SELECT o.user_id AS "userId", o.branch_id AS "branchId",
               COALESCE(SUM(
                 CASE WHEN c.flow_type = 'INCOME' THEN o.grand_total ELSE -o.grand_total END
               ), 0) AS "amount"
        FROM cash_flows c
        JOIN orders o ON o.id = c.order_id
        WHERE c.tenant_id = ${tenantId}
          AND c.created_at >= ${start}
          AND c.created_at < ${end}
        GROUP BY 1, 2
      `,
    ]);

    const byUser = new Map<string, RevenueFigures>();
    const byBranch = new Map<string, RevenueFigures>();
    const add = (
      map: Map<string, RevenueFigures>,
      key: string | null,
      field: keyof RevenueFigures,
      amount: Prisma.Decimal,
    ) => {
      if (!key) return;
      const current = map.get(key) ?? { ...NO_REVENUE };
      current[field] += Number(amount);
      map.set(key, current);
    };

    const flavours = [
      ['gross', gross],
      ['net', net],
      ['collected', collected],
    ] as const;
    for (const [field, rows] of flavours) {
      for (const row of rows) {
        add(byUser, row.userId, field, row.amount);
        add(byBranch, row.branchId, field, row.amount);
      }
    }

    return { byUser, byBranch };
  }

  /** The public holidays in a period, keyed by date. Only these carry a pay multiplier. */
  async holidaysIn(
    tenantId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<Map<string, PayrollHoliday>> {
    const holidays = await this.prisma.holiday.findMany({
      where: {
        tenantId,
        isActive: true,
        date: { gte: periodStart, lte: periodEnd },
      },
      select: { date: true, name: true, type: true },
    });
    return new Map(
      holidays.map((holiday) => [
        dateKey(holiday.date),
        { name: holiday.name, type: holiday.type },
      ]),
    );
  }

  /** One employee's payslip. The order is ported as-is: which penalty rules are configured decides how many minutes are payable, so the deductions have to be read before the shifts are priced. */
  calculate(args: {
    context: PayrollContext;
    periodStart: Date;
    periodEnd: Date;
    holidayByDate: Map<string, PayrollHoliday>;
    settings: PayrollSettings;
  }): CalculatedPayslip {
    const { context, periodStart, periodEnd, holidayByDate, settings } = args;
    const rates = context.rates!;

    const enabled = context.deductions.filter((item) => item.enable);
    const supported = enabled.filter((item) => isSupportedDeduction(item));
    const hasLatePenalty = supported.some((d) => d.deductionType === 'LATE');
    const hasEarlyLeavePenalty = supported.some(
      (d) => d.deductionType === 'EARLY_LEAVE',
    );

    const normalSchedules = context.schedules.filter(
      (schedule) => schedule.scheduleType !== ScheduleKind.OVERTIME,
    );
    const lateViolations = normalSchedules
      .map(
        (schedule) =>
          scheduleLateInfo(
            schedule,
            context.attendances,
            settings.lateGraceMinutes,
          ).violationMinutes,
      )
      .filter((minutes) => minutes > 0);
    const earlyViolations = normalSchedules
      .map((schedule) =>
        scheduleEarlyLeaveMinutes(schedule, context.attendances),
      )
      .filter((minutes) => minutes > 0);

    const payable = toPayableSchedules(context.schedules, context.attendances, {
      hasLatePenalty,
      hasEarlyLeavePenalty,
      graceMinutes: settings.lateGraceMinutes,
    });
    const shiftPay = payForSchedules(payable, rates, holidayByDate, settings);

    // ─── Leave ──────────────────────────────────────────────────────────────
    const rosteredDates = new Set(
      context.schedules
        .filter((s) => s.scheduleType !== ScheduleKind.OVERTIME)
        .map((s) => dateKeyOf(s.workDate)),
    );
    const attendedDates = new Set(
      payable
        .filter((s) => s.scheduleType !== ScheduleKind.OVERTIME)
        .map((s) => dateKeyOf(s.workDate)),
    );
    const window = {
      fromKey: dateKey(periodStart),
      toKey: dateKey(periodEnd),
    };

    let paidLeaveDays = 0;
    let unpaidLeaveDays = 0;
    let paidLeavePay = 0;
    let unpaidLeaveDeduction = 0;

    const leaveLines = context.leaveRequests.map((request) => {
      const allocations = allocateLeaveDays(request, rosteredDates, window);
      let linePaidDays = 0;
      let lineUnpaidDays = 0;
      let linePaidAmount = 0;
      let lineDeducted = 0;

      const dates = allocations.map((allocation) => {
        // Turning up wins: if they worked a day they had booked off, the hours are already paid, and adding leave pay or an unpaid deduction on top would count the day twice.
        if (attendedDates.has(allocation.dateKey)) {
          return {
            date: new Date(`${allocation.dateKey}T00:00:00.000Z`),
            leaveType: allocation.leaveType,
            dayFraction: allocation.dayFraction,
            amount: 0,
            ignoredBecauseAttended: true,
          };
        }

        let amount = 0;
        if (allocation.leaveType === 'PAID') {
          const shiftsThatDay = context.schedules.filter(
            (schedule) =>
              schedule.scheduleType !== ScheduleKind.OVERTIME &&
              dateKeyOf(schedule.workDate) === allocation.dateKey,
          ).length;
          amount =
            paidLeaveDayAmount(rates, settings, shiftsThatDay) *
            allocation.dayFraction;
          linePaidDays += allocation.dayFraction;
          linePaidAmount += amount;
        } else {
          amount =
            unpaidLeaveDayDeduction(rates, settings) * allocation.dayFraction;
          lineUnpaidDays += allocation.dayFraction;
          lineDeducted += amount;
        }

        return {
          date: new Date(`${allocation.dateKey}T00:00:00.000Z`),
          leaveType: allocation.leaveType,
          dayFraction: allocation.dayFraction,
          amount,
          ignoredBecauseAttended: false,
        };
      });

      paidLeaveDays += linePaidDays;
      unpaidLeaveDays += lineUnpaidDays;
      paidLeavePay += linePaidAmount;
      unpaidLeaveDeduction += lineDeducted;

      return {
        leaveRequestId: request.id,
        paidDays: linePaidDays,
        unpaidDays: lineUnpaidDays,
        paidAmount: linePaidAmount,
        deductedAmount: lineDeducted,
        dates,
      };
    });

    // ─── Base pay ───────────────────────────────────────────────────────────
    const isFixed = rates.payType === PayType.FIXED;
    const earned = isFixed
      ? fixedWorkedPay(payable, rates, settings) + paidLeavePay
      : shiftPay.basePay + paidLeavePay;
    // A FIXED employee can never earn more than their period salary, however the days fall.
    const basePay = isFixed ? Math.min(rates.salaryPerPeriod, earned) : earned;
    const grossSalary = basePay + shiftPay.overtimePay;

    // ─── Allowances ─────────────────────────────────────────────────────────
    // A percentage is of the period salary, not of what they actually earned - an allowance is a term of employment, not a share of output.
    const allowanceLines = context.allowances
      .filter((item) => item.enable)
      .map((item) => ({
        name: item.name,
        amountType: item.amountType ?? 'FIXED_AMOUNT',
        amountValue: item.amountValue,
        amount:
          item.amountType === 'PERCENTAGE'
            ? (rates.salaryPerPeriod * item.amountValue) / 100
            : item.amountValue,
      }));
    const allowance = allowanceLines.reduce(
      (total, line) => total + line.amount,
      0,
    );

    // ─── Deductions ─────────────────────────────────────────────────────────
    const calculationWarnings: string[] = [];
    if (supported.length !== enabled.length) {
      // Skipped rather than guessed: a wrong deduction is money taken off somebody's pay for a rule nobody wrote down.
      calculationWarnings.push('UNSUPPORTED_DEDUCTION_RULE');
    }

    const deductionLines = supported.map((rule) => {
      const violations =
        rule.deductionType === 'LATE'
          ? lateViolations
          : rule.deductionType === 'EARLY_LEAVE'
            ? earlyViolations
            : [];
      const units = deductionUnits(rule, violations);

      return {
        name: rule.name,
        deductionType: rule.deductionType,
        conditionType: rule.conditionType,
        blockMinutes:
          rule.conditionType === 'BY_BLOCK' ? rule.blockMinutes : null,
        deductionValue: rule.deductionValue,
        violationMinutes: violations.reduce((total, m) => total + m, 0),
        units,
        amount: units * rule.deductionValue,
      };
    });
    const deduction = deductionLines.reduce(
      (total, line) => total + line.amount,
      0,
    );

    // ─── Bonuses ────────────────────────────────────────────────────────────
    // Last, because a MINIMUM_AVENUE_INCOME rule is a floor on take-home pay and has to see the allowances and deductions before it - see `payBonuses`.
    const {
      bonus,
      lines: bonusLines,
      warnings: bonusWarnings,
    } = payBonuses({
      rules: context.bonuses,
      employee: context.revenue.employee,
      branch: context.revenue.branch,
      hasBranch: context.user.branchId !== null,
      incomeBeforeBonus: grossSalary + allowance - deduction,
    });
    calculationWarnings.push(...bonusWarnings);

    return {
      userId: context.user.id,
      paysheetId: context.paysheetId!,
      totalWorkedDays: workedDayCount(payable),
      totalWorkedHours:
        payable.reduce((total, s) => total + s.actualWorkedMinutes, 0) / 60,
      basePay,
      overtimePay: shiftPay.overtimePay,
      paidLeaveDays,
      unpaidLeaveDays,
      paidLeavePay,
      unpaidLeaveDeduction,
      bonus,
      allowance,
      grossSalary,
      deduction,
      netSalary: grossSalary + bonus + allowance - deduction,
      allowanceLines,
      bonusLines,
      deductionLines,
      leaveLines,
      calculationWarnings,
      lines: shiftPay.lines,
    };
  }

  /** Why an employee can't be paid this period, or `null` if they can. Both reasons are configuration gaps, reported per employee so a manager can see exactly who to fix. */
  skipReason(context: PayrollContext): string | null {
    if (!context.rates) return 'Nhân viên chưa được gán bảng lương';
    if (
      context.rates.payType === PayType.FIXED &&
      !(context.rates.salaryPerPeriod > 0)
    ) {
      return 'Cấu hình lương cố định thiếu mức lương theo kỳ (salaryPerPeriod), không thể tính lương và làm thêm giờ';
    }
    return null;
  }
}
