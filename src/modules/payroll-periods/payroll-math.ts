/** Every rule that decides how much somebody is paid, as pure functions with no database access: the service loads the shifts, attendances, leave and holidays and hands them in, so every number here is testable without a connection. Same shape as `promotions/pricing-engine.ts`. */

const MINUTES_PER_HOUR = 60;

/** What kind of day a shift falls on. Drives both the base and the overtime multiplier. */
export const DayType = {
  NORMAL: 'NORMAL',
  WEEKEND: 'WEEKEND',
  HOLIDAY: 'HOLIDAY',
  WEEKEND_HOLIDAY: 'WEEKEND_HOLIDAY',
} as const;

export const PayType = {
  PAY_BY_SHIFT: 'PAY_BY_SHIFT',
  STANDARD_WORKING_DAY: 'STANDARD_WORKING_DAY',
  FIXED: 'FIXED',
} as const;

export const ScheduleKind = { NORMAL: 'NORMAL', OVERTIME: 'OVERTIME' } as const;

export interface PayrollSettings {
  standardWorkingDays: number;
  standardWorkingHoursPerDay: number;
  /** Day-of-week numbers (0 = Sunday) that count as a weekend. */
  weekendDays: number[];
  lateGraceMinutes: number;
}

/** The pay rules attached to an employee, flattened from their Paysheet. */
export interface PaysheetRates {
  payType: string | null;
  amountPerShift: number;
  salaryPerPeriod: number;
  standardWorkingDaySalary: number;
  baseWeekend: number;
  basePublicHoliday: number;
  overtimeNormalDay: number;
  overtimeWeekend: number;
  overtimePublicHoliday: number;
}

export interface SchedulePeriod {
  id: string;
  scheduleType: string;
  workDate: string;
  startAt: Date;
  endAt: Date;
}

export interface AttendanceSpan {
  scheduleId: string | null;
  actualCheckinAt: Date | null;
  actualCheckoutAt: Date | null;
  lateMinutes: number | null;
}

/** A shift with the minutes payroll will actually pay for worked out. */
export interface PayableSchedule extends SchedulePeriod {
  actualWorkedMinutes: number;
  payableMinutes: number;
}

export interface PayLine {
  scheduleId: string;
  scheduleType: string;
  dayType: string;
  rate: number;
  scheduledMinutes: number;
  payableMinutes: number;
  amount: number;
  holidayName: string | null;
}

/** A public holiday, as payroll sees it. */
export interface PayrollHoliday {
  name: string;
  type: string;
}

// ─── Day classification ──────────────────────────────────────────────────────

export function dateKeyOf(value: Date | string): string {
  return typeof value === 'string'
    ? value.slice(0, 10)
    : value.toISOString().slice(0, 10);
}

/** Only `PUBLIC_HOLIDAY` counts for pay: a `COMPANY_HOLIDAY` is the shop's own closure and carries no statutory multiplier, so paying a holiday rate for one would be inventing money. */
export function payrollHolidayOf(
  holiday: PayrollHoliday | null | undefined,
): PayrollHoliday | null {
  return holiday?.type === 'PUBLIC_HOLIDAY' ? holiday : null;
}

export function dayTypeOf(
  workDate: Date | string,
  holiday: PayrollHoliday | null,
  weekendDays: number[],
): string {
  const day = new Date(`${dateKeyOf(workDate)}T00:00:00.000Z`).getUTCDay();
  const weekend = weekendDays.includes(day);
  const publicHoliday = payrollHolidayOf(holiday) !== null;

  if (weekend && publicHoliday) return DayType.WEEKEND_HOLIDAY;
  if (weekend) return DayType.WEEKEND;
  if (publicHoliday) return DayType.HOLIDAY;
  return DayType.NORMAL;
}

/** A public holiday outranks a weekend when both fall on the same day - the higher of the two rates applies, not both. Ported verbatim. */
function rateKindOf(
  dayType: string,
  holiday: PayrollHoliday | null,
): 'weekend' | 'publicHoliday' | null {
  if (payrollHolidayOf(holiday)) return 'publicHoliday';
  if (dayType === DayType.WEEKEND) return 'weekend';
  return null;
}

export function basePayRate(
  rates: PaysheetRates,
  dayType: string,
  holiday: PayrollHoliday | null,
): number {
  const kind = rateKindOf(dayType, holiday);
  if (!kind) return 1;
  return kind === 'weekend' ? rates.baseWeekend : rates.basePublicHoliday;
}

export function overtimePayRate(
  rates: PaysheetRates,
  dayType: string,
  holiday: PayrollHoliday | null,
): number {
  const kind = rateKindOf(dayType, holiday);
  if (!kind) return rates.overtimeNormalDay;
  return kind === 'weekend'
    ? rates.overtimeWeekend
    : rates.overtimePublicHoliday;
}

// ─── Time on the clock ───────────────────────────────────────────────────────

export function scheduleMinutes(schedule: SchedulePeriod): number {
  const start = schedule.startAt.getTime();
  const end = schedule.endAt.getTime();
  return end <= start ? 0 : Math.floor((end - start) / 60_000);
}

/** Merges overlapping intervals so shared time is counted once. */
function mergeRanges(
  ranges: { start: number; end: number }[],
): { start: number; end: number }[] {
  const valid = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** The attendance rows belonging to a shift, matched on `scheduleId` with a deliberately narrow overlap fallback for rows written before it was recorded - without the overlap test it would pick up a different shift the same day and pay twice. */
export function attendancesForSchedule(
  schedule: SchedulePeriod,
  attendances: AttendanceSpan[],
): AttendanceSpan[] {
  const byId = attendances.filter(
    (attendance) => attendance.scheduleId === schedule.id,
  );
  if (byId.length > 0) return byId;

  const start = schedule.startAt.getTime();
  const end = schedule.endAt.getTime();
  return attendances.filter((attendance) => {
    if (!attendance.actualCheckinAt) return false;
    const checkin = attendance.actualCheckinAt.getTime();
    const checkout = attendance.actualCheckoutAt?.getTime() ?? checkin;
    return checkin < end && checkout > start;
  });
}

/** Minutes actually worked inside a shift's window, clipped at both ends (arriving early doesn't earn, staying late is overtime only if rostered) and merged first so two overlapping rows can't be paid twice. */
export function payableMinutesOf(
  schedule: SchedulePeriod,
  attendances: AttendanceSpan[],
): number {
  const start = schedule.startAt.getTime();
  const end = schedule.endAt.getTime();

  const ranges = attendances
    .filter((a) => a.actualCheckinAt && a.actualCheckoutAt)
    .map((a) => ({
      start: Math.max(a.actualCheckinAt!.getTime(), start),
      end: Math.min(a.actualCheckoutAt!.getTime(), end),
    }));

  return mergeRanges(ranges).reduce(
    (total, range) => total + Math.floor((range.end - range.start) / 60_000),
    0,
  );
}

/** How late the person was, raw and after the grace period. Prefers the stored `lateMinutes` and derives it only when absent, so rows written before check-in recorded it still work. Overtime shifts are never late. */
export function scheduleLateInfo(
  schedule: SchedulePeriod,
  attendances: AttendanceSpan[],
  graceMinutes: number,
): { rawMinutes: number; violationMinutes: number } {
  if (schedule.scheduleType === ScheduleKind.OVERTIME) {
    return { rawMinutes: 0, violationMinutes: 0 };
  }

  const checkedIn = attendancesForSchedule(schedule, attendances).filter(
    (a) => a.actualCheckinAt,
  );
  if (checkedIn.length === 0) return { rawMinutes: 0, violationMinutes: 0 };

  // The earliest check-in decides lateness - arriving twice doesn't make you later.
  const earliest = checkedIn.reduce((first, attendance) =>
    attendance.actualCheckinAt!.getTime() < first.actualCheckinAt!.getTime()
      ? attendance
      : first,
  );
  const rawMinutes = Math.max(
    0,
    Math.floor(
      (earliest.actualCheckinAt!.getTime() - schedule.startAt.getTime()) /
        60_000,
    ),
  );

  const stored = earliest.lateMinutes;
  const violationMinutes =
    stored !== null && Number.isFinite(stored)
      ? Math.max(0, stored)
      : rawMinutes <= graceMinutes
        ? 0
        : rawMinutes;

  return { rawMinutes, violationMinutes };
}

/** Minutes left before the shift ended, using the latest checkout: clocking out and back in shouldn't count as leaving early twice. */
export function scheduleEarlyLeaveMinutes(
  schedule: SchedulePeriod,
  attendances: AttendanceSpan[],
): number {
  if (schedule.scheduleType === ScheduleKind.OVERTIME) return 0;

  const checkedOut = attendancesForSchedule(schedule, attendances).filter(
    (a) => a.actualCheckoutAt,
  );
  if (checkedOut.length === 0) return 0;

  const latest = Math.max(
    ...checkedOut.map((a) => a.actualCheckoutAt!.getTime()),
  );
  return Math.max(0, Math.floor((schedule.endAt.getTime() - latest) / 60_000));
}

/** Turns rostered shifts into payable ones and drops the ones nobody turned up to. The restoration rules exist so nobody is punished twice: with a late-penalty rule active the whole shortfall is added back, because the money is taken by the penalty instead; without one, only the grace minutes return. Capped at the shift's own length. */
export function toPayableSchedules(
  schedules: SchedulePeriod[],
  attendances: AttendanceSpan[],
  options: {
    hasLatePenalty: boolean;
    hasEarlyLeavePenalty: boolean;
    graceMinutes: number;
  },
): PayableSchedule[] {
  return schedules
    .map((schedule) => {
      const own = attendancesForSchedule(schedule, attendances);
      const actualWorkedMinutes = payableMinutesOf(schedule, own);
      const { rawMinutes, violationMinutes } = scheduleLateInfo(
        schedule,
        attendances,
        options.graceMinutes,
      );

      const restoredLate = options.hasLatePenalty
        ? rawMinutes
        : Math.max(0, rawMinutes - violationMinutes);
      const restoredEarly = options.hasEarlyLeavePenalty
        ? scheduleEarlyLeaveMinutes(schedule, attendances)
        : 0;

      return {
        ...schedule,
        actualWorkedMinutes,
        payableMinutes: Math.min(
          scheduleMinutes(schedule),
          actualWorkedMinutes + restoredLate + restoredEarly,
        ),
      };
    })
    .filter((schedule) => schedule.actualWorkedMinutes > 0);
}

// ─── Pay per shift ───────────────────────────────────────────────────────────

/** What one shift is worth. A FIXED employee's normal shifts produce a zero line on purpose - their period salary is pro-rated in `fixedWorkedPay`, since doing it per shift would make capping a day at one day's pay impossible - but the line is still emitted so the payslip can show the day. */
export function schedulePay(
  schedule: PayableSchedule,
  rates: PaysheetRates,
  holiday: PayrollHoliday | null,
  settings: PayrollSettings,
): PayLine {
  const payrollHoliday = payrollHolidayOf(holiday);
  const dayType = dayTypeOf(
    schedule.workDate,
    payrollHoliday,
    settings.weekendDays,
  );
  const scheduled = scheduleMinutes(schedule);
  const payable = Math.max(0, schedule.payableMinutes);
  const workedRatio = scheduled ? payable / scheduled : 0;

  const shared = {
    scheduleId: schedule.id,
    scheduleType: schedule.scheduleType,
    dayType,
    scheduledMinutes: scheduled,
    payableMinutes: payable,
    holidayName: payrollHoliday?.name ?? null,
  };

  if (schedule.scheduleType === ScheduleKind.OVERTIME) {
    const rate = overtimePayRate(rates, dayType, payrollHoliday);
    return {
      ...shared,
      rate,
      amount:
        (payable / MINUTES_PER_HOUR) *
        hourlyRateOf(rates, scheduled, settings) *
        rate,
    };
  }

  const rate = basePayRate(rates, dayType, payrollHoliday);
  let base = 0;
  if (rates.payType === PayType.PAY_BY_SHIFT) {
    base = rates.amountPerShift * workedRatio;
  } else if (rates.payType === PayType.STANDARD_WORKING_DAY) {
    base = rates.standardWorkingDaySalary * workedRatio;
  }
  return { ...shared, rate, amount: base * rate };
}

/** What an hour of overtime is worth, derived from whichever pay scheme applies. */
function hourlyRateOf(
  rates: PaysheetRates,
  shiftMinutes: number,
  settings: PayrollSettings,
): number {
  if (rates.payType === PayType.FIXED) {
    return (
      rates.salaryPerPeriod /
      settings.standardWorkingDays /
      settings.standardWorkingHoursPerDay
    );
  }
  if (rates.payType === PayType.STANDARD_WORKING_DAY) {
    return rates.standardWorkingDaySalary / settings.standardWorkingHoursPerDay;
  }
  // PAY_BY_SHIFT: the shift's own rate spread across its own length.
  return shiftMinutes
    ? rates.amountPerShift / (shiftMinutes / MINUTES_PER_HOUR)
    : 0;
}

export function payForSchedules(
  schedules: PayableSchedule[],
  rates: PaysheetRates,
  holidayByDate: Map<string, PayrollHoliday>,
  settings: PayrollSettings,
): { basePay: number; overtimePay: number; lines: PayLine[] } {
  const lines = schedules.map((schedule) =>
    schedulePay(
      schedule,
      rates,
      holidayByDate.get(dateKeyOf(schedule.workDate)) ?? null,
      settings,
    ),
  );

  return {
    basePay: lines
      .filter((line) => line.scheduleType !== ScheduleKind.OVERTIME)
      .reduce((total, line) => total + line.amount, 0),
    overtimePay: lines
      .filter((line) => line.scheduleType === ScheduleKind.OVERTIME)
      .reduce((total, line) => total + line.amount, 0),
    lines,
  };
}

// ─── Leave ───────────────────────────────────────────────────────────────────

export interface LeaveAllocation {
  dateKey: string;
  leaveType: 'PAID' | 'UNPAID';
  dayFraction: number;
}

/** Spreads a request's approved paid/unpaid totals across the days it covers: paid days first, from the earliest rostered day, and a day may be split. Only rostered days consume leave, and `schedules` covers the whole request so one straddling two periods spends its paid days once. */
export function allocateLeaveDays(
  request: {
    startDate: Date;
    endDate: Date;
    paidLeaveDays: number;
    unpaidLeaveDays: number;
  },
  rosteredDateKeys: Set<string>,
  window: { fromKey: string; toKey: string },
): LeaveAllocation[] {
  const workDates: string[] = [];
  for (
    let day = new Date(`${dateKeyOf(request.startDate)}T00:00:00.000Z`);
    day <= new Date(`${dateKeyOf(request.endDate)}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const key = dateKeyOf(day);
    if (rosteredDateKeys.has(key)) workDates.push(key);
  }

  let paidLeft = request.paidLeaveDays;
  let unpaidLeft = request.unpaidLeaveDays;
  const allocations: LeaveAllocation[] = [];

  for (const dateKey of workDates) {
    let dayLeft = 1;

    if (paidLeft > 0) {
      const fraction = Math.min(dayLeft, paidLeft);
      paidLeft -= fraction;
      dayLeft -= fraction;
      if (dateKey >= window.fromKey && dateKey <= window.toKey) {
        allocations.push({ dateKey, leaveType: 'PAID', dayFraction: fraction });
      }
    }
    if (dayLeft > 0 && unpaidLeft > 0) {
      const fraction = Math.min(dayLeft, unpaidLeft);
      unpaidLeft -= fraction;
      if (dateKey >= window.fromKey && dateKey <= window.toKey) {
        allocations.push({
          dateKey,
          leaveType: 'UNPAID',
          dayFraction: fraction,
        });
      }
    }
    if (paidLeft <= 0 && unpaidLeft <= 0) break;
  }

  return allocations;
}

/** What one paid leave day is worth. `PAY_BY_SHIFT` pays the shifts rostered that day, excluding overtime - a day off doesn't earn the overtime somebody would have chosen to work. */
export function paidLeaveDayAmount(
  rates: PaysheetRates,
  settings: PayrollSettings,
  shiftsThatDay: number,
): number {
  if (rates.payType === PayType.FIXED) {
    return rates.salaryPerPeriod / settings.standardWorkingDays;
  }
  if (rates.payType === PayType.STANDARD_WORKING_DAY) {
    return rates.standardWorkingDaySalary;
  }
  return shiftsThatDay * rates.amountPerShift;
}

/** What one unpaid leave day costs. Only FIXED has anything to deduct: the other schemes pay for shifts worked, so a day not worked already earns nothing. */
export function unpaidLeaveDayDeduction(
  rates: PaysheetRates,
  settings: PayrollSettings,
): number {
  return rates.payType === PayType.FIXED
    ? rates.salaryPerPeriod / settings.standardWorkingDays
    : 0;
}

// ─── Deductions ──────────────────────────────────────────────────────────────

/** Whether a configured deduction is one this engine can price - fixed amounts in three shapes only. Anything else is reported as `UNSUPPORTED_DEDUCTION_RULE` rather than guessed at, since a wrong deduction is money taken off for a rule nobody wrote down. */
export function isSupportedDeduction(rule: {
  deductionType: string;
  conditionType: string | null;
}): boolean {
  return (
    rule.deductionType === 'FIXED' ||
    rule.conditionType === 'BY_OCCURRENCE' ||
    rule.conditionType === 'BY_BLOCK'
  );
}

/** How many units of a deduction a set of violations earns. `BY_BLOCK` rounds each violation up separately - two 16-minute violations against a 15-minute block are 4 blocks, not 3 - or repeated small violations would escape. */
export function deductionUnits(
  rule: {
    deductionType: string;
    conditionType: string | null;
    blockMinutes: number | null;
  },
  violationMinutes: number[],
): number {
  if (rule.deductionType === 'FIXED') return 1;
  if (rule.conditionType === 'BY_BLOCK' && rule.blockMinutes) {
    return violationMinutes.reduce(
      (total, minutes) => total + Math.ceil(minutes / rule.blockMinutes!),
      0,
    );
  }
  return violationMinutes.length;
}

// ─── Fixed-salary proration ──────────────────────────────────────────────────

/** A FIXED employee's earned salary for the days they actually worked: each day is its worked minutes over the standard day, capped at one day, so two shifts can't earn two days of a monthly salary. */
export function fixedWorkedPay(
  schedules: PayableSchedule[],
  rates: PaysheetRates,
  settings: PayrollSettings,
): number {
  const standardMinutes = settings.standardWorkingHoursPerDay * 60;

  const byDate = new Map<string, number>();
  for (const schedule of schedules) {
    if (schedule.scheduleType === ScheduleKind.OVERTIME) continue;
    const key = dateKeyOf(schedule.workDate);
    byDate.set(key, (byDate.get(key) ?? 0) + schedule.payableMinutes);
  }

  const dayUnits = [...byDate.values()].reduce(
    (total, minutes) => total + Math.min(1, minutes / standardMinutes),
    0,
  );
  return dayUnits * (rates.salaryPerPeriod / settings.standardWorkingDays);
}

/** Distinct days worked. Overtime shifts don't add a day - they are paid separately. */
export function workedDayCount(schedules: PayableSchedule[]): number {
  return new Set(
    schedules
      .filter((schedule) => schedule.scheduleType !== ScheduleKind.OVERTIME)
      .map((schedule) => dateKeyOf(schedule.workDate)),
  ).size;
}

// ─── Bonuses ─────────────────────────────────────────────────────────────────
// The revenue-tier bonus on a paysheet. Neither codebase ever priced this, so nothing below is a port - three decisions were the shop owner's and were taken 2026-09-06: the highest tier reached wins flat over the whole revenue (not progressive, not summed); MINIMUM_AVENUE_INCOME is a guaranteed income floor tiered by revenue ("AVENUE" is a typo for REVENUE in both schemas and stays as the wire format); and GROSS/NET/COLLECTED_REVENUE are before discount, after discount, and money actually received.

export const BonusType = {
  EMPLOYEE_REVENUE: 'EMPLOYEE_REVENUE',
  BRANCH_REVENUE: 'BRANCH_REVENUE',
  /** Kept misspelt on purpose - it is the stored value in both databases. */
  MINIMUM_INCOME: 'MINIMUM_AVENUE_INCOME',
} as const;

export type BonusType = (typeof BonusType)[keyof typeof BonusType];

export const BonusCalculation = {
  GROSS_REVENUE: 'GROSS_REVENUE',
  NET_REVENUE: 'NET_REVENUE',
  COLLECTED_REVENUE: 'COLLECTED_REVENUE',
} as const;

export type BonusCalculation =
  (typeof BonusCalculation)[keyof typeof BonusCalculation];

export const RewardType = {
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  PERCENTAGE: 'PERCENTAGE',
} as const;

export type RewardType = (typeof RewardType)[keyof typeof RewardType];

/** Warnings a payslip carries when a bonus rule could not be priced. */
export const BonusWarning = {
  UNSUPPORTED_TYPE: 'UNSUPPORTED_BONUS_TYPE',
  UNSUPPORTED_CALCULATION: 'UNSUPPORTED_BONUS_CALCULATION',
  UNSUPPORTED_REWARD: 'UNSUPPORTED_BONUS_REWARD',
  NO_BRANCH: 'BRANCH_BONUS_WITHOUT_BRANCH',
} as const;

/** One row of the tenant's revenue in a period, in each of the three flavours. */
export interface RevenueFigures {
  gross: number;
  net: number;
  collected: number;
}

export const NO_REVENUE: RevenueFigures = { gross: 0, net: 0, collected: 0 };

export interface BonusTier {
  name: string | null;
  fromValue: number | null;
  rewardType: string | null;
  rewardValue: number | null;
  position: number;
}

export interface BonusRule {
  bonusType: string;
  calculationType: string;
  enable: boolean;
  tiers: BonusTier[];
}

export interface BonusLine {
  bonusType: string;
  calculationType: string;
  revenue: number;
  tierName: string | null;
  fromValue: number | null;
  rewardType: string | null;
  rewardValue: number | null;
  amount: number;
}

export interface BonusResult {
  bonus: number;
  lines: BonusLine[];
  warnings: string[];
}

/** Which of the three revenue figures a rule measures, or `null` if it names none of them. */
export function revenueFor(
  calculationType: string,
  figures: RevenueFigures,
): number | null {
  switch (calculationType) {
    case BonusCalculation.GROSS_REVENUE:
      return figures.gross;
    case BonusCalculation.NET_REVENUE:
      return figures.net;
    case BonusCalculation.COLLECTED_REVENUE:
      return figures.collected;
    default:
      return null;
  }
}

/** The tier a revenue figure lands in - the highest `fromValue` it reaches, or `null`. A missing `fromValue` is a threshold of zero, and ties are broken by `position` with the last one winning, since two tiers at one threshold is a mistake and predictability is the most that can be offered. */
export function tierFor(
  tiers: readonly BonusTier[],
  revenue: number,
): BonusTier | null {
  let best: BonusTier | null = null;
  for (const tier of tiers) {
    const threshold = tier.fromValue ?? 0;
    if (revenue < threshold) continue;
    if (
      !best ||
      threshold > (best.fromValue ?? 0) ||
      (threshold === (best.fromValue ?? 0) && tier.position >= best.position)
    ) {
      best = tier;
    }
  }
  return best;
}

/** What a tier pays on a revenue figure; `null` means a reward type nothing here understands, which is reported rather than guessed. `PERCENTAGE` is of the whole revenue, not the amount above the threshold - that is what "highest tier wins" means. */
export function rewardOf(tier: BonusTier, revenue: number): number | null {
  const value = tier.rewardValue ?? 0;
  switch (tier.rewardType) {
    case RewardType.FIXED_AMOUNT:
      return value;
    case RewardType.PERCENTAGE:
      return (revenue * value) / 100;
    default:
      return null;
  }
}

interface PayBonusesInput {
  rules: readonly BonusRule[];
  /** The employee's own takings, by `Order.userId` - the same attribution `/stats/revenue-by-staff` uses. */
  employee: RevenueFigures;
  /** Their branch's takings. */
  branch: RevenueFigures;
  /** False when they are posted at a warehouse or nowhere: there is no branch to measure. */
  hasBranch: boolean;
  /** Pay before any bonus - `grossSalary + allowance − deduction`. The floor is measured against this. */
  incomeBeforeBonus: number;
}

/** Every enabled bonus rule on a paysheet, priced. The income floor is applied last and that ordering is the rule: a guarantee is a floor on take-home, so it has to see the revenue bonuses before it. A rule that reaches no tier still produces a `0` line, because an absent row gets read as a bug. */
export function payBonuses(input: PayBonusesInput): BonusResult {
  const enabled = input.rules.filter((rule) => rule.enable);
  const lines: BonusLine[] = [];
  const warnings = new Set<string>();

  const price = (rule: BonusRule) => {
    const figures =
      rule.bonusType === BonusType.BRANCH_REVENUE
        ? input.branch
        : input.employee;
    if (rule.bonusType === BonusType.BRANCH_REVENUE && !input.hasBranch) {
      // Posted at a warehouse, or nowhere: there is no branch whose takings this could mean, and picking one would be inventing the number.
      warnings.add(BonusWarning.NO_BRANCH);
      return null;
    }

    const revenue = revenueFor(rule.calculationType, figures);
    if (revenue === null) {
      warnings.add(BonusWarning.UNSUPPORTED_CALCULATION);
      return null;
    }

    const tier = tierFor(rule.tiers, revenue);
    return { revenue, tier };
  };

  const lineOf = (
    rule: BonusRule,
    revenue: number,
    tier: BonusTier | null,
    amount: number,
  ): BonusLine => ({
    bonusType: rule.bonusType,
    calculationType: rule.calculationType,
    revenue,
    tierName: tier?.name ?? null,
    fromValue: tier?.fromValue ?? null,
    rewardType: tier?.rewardType ?? null,
    rewardValue: tier?.rewardValue ?? null,
    amount,
  });

  // ── Revenue bonuses first ────────────────────────────────────────────────
  let bonus = 0;
  const floors: BonusRule[] = [];

  for (const rule of enabled) {
    if (rule.bonusType === BonusType.MINIMUM_INCOME) {
      floors.push(rule);
      continue;
    }
    if (
      rule.bonusType !== BonusType.EMPLOYEE_REVENUE &&
      rule.bonusType !== BonusType.BRANCH_REVENUE
    ) {
      warnings.add(BonusWarning.UNSUPPORTED_TYPE);
      continue;
    }

    const priced = price(rule);
    if (!priced) continue;

    if (!priced.tier) {
      lines.push(lineOf(rule, priced.revenue, null, 0));
      continue;
    }

    const reward = rewardOf(priced.tier, priced.revenue);
    if (reward === null) {
      warnings.add(BonusWarning.UNSUPPORTED_REWARD);
      lines.push(lineOf(rule, priced.revenue, priced.tier, 0));
      continue;
    }

    const amount = Math.max(0, reward);
    bonus += amount;
    lines.push(lineOf(rule, priced.revenue, priced.tier, amount));
  }

  // ── Then the guarantee, against everything above ─────────────────────────
  for (const rule of floors) {
    const priced = price(rule);
    if (!priced) continue;

    if (!priced.tier) {
      lines.push(lineOf(rule, priced.revenue, null, 0));
      continue;
    }

    // Here the reward is not an amount to add: it is the income being promised.
    const guaranteed = rewardOf(priced.tier, priced.revenue);
    if (guaranteed === null) {
      warnings.add(BonusWarning.UNSUPPORTED_REWARD);
      lines.push(lineOf(rule, priced.revenue, priced.tier, 0));
      continue;
    }

    const topUp = Math.max(0, guaranteed - (input.incomeBeforeBonus + bonus));
    bonus += topUp;
    lines.push(lineOf(rule, priced.revenue, priced.tier, topUp));
  }

  return { bonus, lines, warnings: [...warnings] };
}
