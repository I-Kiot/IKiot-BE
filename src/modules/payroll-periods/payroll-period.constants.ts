/** Vietnam is UTC+7 year-round - see `working-schedules/schedule-time.ts`. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export const PayrollPeriodStatus = {
  DRAFT: 'DRAFT',
  REVIEW: 'REVIEW',
  APPROVED: 'APPROVED',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
} as const;

export const PAYROLL_PERIOD_STATUSES = Object.values(PayrollPeriodStatus);

/** The actions that move a period, and where each one may run from. */
export const PAYROLL_TRANSITIONS = {
  SUBMIT: { from: PayrollPeriodStatus.DRAFT, to: PayrollPeriodStatus.REVIEW },
  CANCEL: {
    from: PayrollPeriodStatus.DRAFT,
    to: PayrollPeriodStatus.CANCELLED,
  },
  RETURN_TO_DRAFT: {
    from: PayrollPeriodStatus.REVIEW,
    to: PayrollPeriodStatus.DRAFT,
  },
  APPROVE: {
    from: PayrollPeriodStatus.REVIEW,
    to: PayrollPeriodStatus.APPROVED,
  },
  MARK_PAID: {
    from: PayrollPeriodStatus.APPROVED,
    to: PayrollPeriodStatus.PAID,
  },
} as const;

export type PayrollAction = keyof typeof PAYROLL_TRANSITIONS;

/** The payslip statuses an employee may see. DRAFT and CANCELLED are absent on purpose; REVIEW is visible, because that window exists so employees can check provisional figures and object before APPROVED fixes them. */
export const EMPLOYEE_VISIBLE_PAYSLIP_STATUSES = [
  PayrollPeriodStatus.REVIEW,
  PayrollPeriodStatus.APPROVED,
  PayrollPeriodStatus.PAID,
];

/** A payroll period covers a whole calendar month - `PayrollSetting.periodStartDay` is not honoured, as it wasn't in iKiotMS-BE. Dates are plain UTC midnights matching the `@db.Date` columns, which removes the whole off-by-one class the old Vietnam-midnight instants needed a dance to avoid. */
export function monthlyPeriodRange(payrollMonth: string): {
  periodStart: Date;
  periodEnd: Date;
  startKey: string;
  endKey: string;
  year: number;
  month: number;
} {
  const [year, month] = payrollMonth.split('-').map(Number);
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  // Day 0 of the next month is the last day of this one.
  const periodEnd = new Date(Date.UTC(year, month, 0));

  return {
    periodStart,
    periodEnd,
    startKey: periodStart.toISOString().slice(0, 10),
    endKey: periodEnd.toISOString().slice(0, 10),
    year,
    month,
  };
}

/** Today's date in the shop's timezone - what "has the period ended" is judged against. */
export function vietnamToday(now = new Date()): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for a stored `@db.Date`. */
export function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}
