import {
  allocateLeaveDays,
  basePayRate,
  NO_REVENUE,
  payBonuses,
  rewardOf,
  tierFor,
  dayTypeOf,
  deductionUnits,
  fixedWorkedPay,
  isSupportedDeduction,
  overtimePayRate,
  paidLeaveDayAmount,
  payableMinutesOf,
  scheduleEarlyLeaveMinutes,
  scheduleLateInfo,
  schedulePay,
  toPayableSchedules,
  unpaidLeaveDayDeduction,
  workedDayCount,
} from './payroll-math';
import type {
  AttendanceSpan,
  BonusRule,
  BonusTier,
  PayableSchedule,
  RevenueFigures,
  PayrollSettings,
  PaysheetRates,
  SchedulePeriod,
} from './payroll-math';

const settings: PayrollSettings = {
  standardWorkingDays: 26,
  standardWorkingHoursPerDay: 8,
  weekendDays: [0],
  lateGraceMinutes: 15,
};

const rates = (over: Partial<PaysheetRates> = {}): PaysheetRates => ({
  payType: 'PAY_BY_SHIFT',
  amountPerShift: 400_000,
  salaryPerPeriod: 13_000_000,
  standardWorkingDaySalary: 500_000,
  baseWeekend: 2,
  basePublicHoliday: 3,
  overtimeNormalDay: 1.5,
  overtimeWeekend: 2,
  overtimePublicHoliday: 3,
  ...over,
});

/** A Monday 08:00–17:00 shift (Vietnam), i.e. 01:00–10:00 UTC. */
const shift = (over: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: 'sched-1',
  scheduleType: 'NORMAL',
  workDate: '2026-09-07',
  startAt: new Date('2026-09-07T01:00:00.000Z'),
  endAt: new Date('2026-09-07T10:00:00.000Z'),
  ...over,
});

const attendance = (over: Partial<AttendanceSpan> = {}): AttendanceSpan => ({
  scheduleId: 'sched-1',
  actualCheckinAt: new Date('2026-09-07T01:00:00.000Z'),
  actualCheckoutAt: new Date('2026-09-07T10:00:00.000Z'),
  lateMinutes: 0,
  ...over,
});

const payable = (over: Partial<PayableSchedule> = {}): PayableSchedule => ({
  ...shift(),
  actualWorkedMinutes: 540,
  payableMinutes: 540,
  ...over,
});

const HOLIDAY = { name: 'Quốc khánh', type: 'PUBLIC_HOLIDAY' };
const COMPANY = { name: 'Nghỉ công ty', type: 'COMPANY_HOLIDAY' };

describe('day classification and rates', () => {
  it('reads a Sunday as the weekend', () => {
    expect(dayTypeOf('2026-09-06', null, [0])).toBe('WEEKEND');
    expect(dayTypeOf('2026-09-07', null, [0])).toBe('NORMAL');
  });

  // A shop's own closure carries no statutory multiplier; paying one would invent money.
  it('ignores a COMPANY_HOLIDAY entirely', () => {
    expect(dayTypeOf('2026-09-07', COMPANY, [0])).toBe('NORMAL');
    expect(basePayRate(rates(), 'NORMAL', COMPANY)).toBe(1);
  });

  it('lets a public holiday outrank a weekend rather than stacking', () => {
    expect(dayTypeOf('2026-09-06', HOLIDAY, [0])).toBe('WEEKEND_HOLIDAY');
    // 3, not 2 and not 6.
    expect(basePayRate(rates(), 'WEEKEND_HOLIDAY', HOLIDAY)).toBe(3);
    expect(overtimePayRate(rates(), 'WEEKEND_HOLIDAY', HOLIDAY)).toBe(3);
  });

  it('pays a normal day at 1× base and 1.5× overtime', () => {
    expect(basePayRate(rates(), 'NORMAL', null)).toBe(1);
    expect(overtimePayRate(rates(), 'NORMAL', null)).toBe(1.5);
  });
});

describe('payableMinutesOf', () => {
  it('clips the clock to the shift at both ends', () => {
    const early = attendance({
      actualCheckinAt: new Date('2026-09-07T00:30:00.000Z'),
      actualCheckoutAt: new Date('2026-09-07T11:00:00.000Z'),
    });
    // 09:00 of shift, not 10:30 of presence.
    expect(payableMinutesOf(shift(), [early])).toBe(540);
  });

  // Two overlapping attendance rows on one shift must not both be paid.
  it('merges overlapping attendance rather than adding it up', () => {
    const first = attendance({
      actualCheckoutAt: new Date('2026-09-07T06:00:00.000Z'),
    });
    const second = attendance({
      actualCheckinAt: new Date('2026-09-07T05:00:00.000Z'),
      actualCheckoutAt: new Date('2026-09-07T08:00:00.000Z'),
    });
    // 01:00–08:00 = 420, not 300 + 180.
    expect(payableMinutesOf(shift(), [first, second])).toBe(420);
  });

  it('pays nothing for a shift clocked into but never out of', () => {
    expect(
      payableMinutesOf(shift(), [attendance({ actualCheckoutAt: null })]),
    ).toBe(0);
  });
});

describe('scheduleLateInfo', () => {
  it('prefers the stored lateMinutes over deriving one', () => {
    const late = attendance({
      actualCheckinAt: new Date('2026-09-07T01:40:00.000Z'),
      lateMinutes: 40,
    });
    expect(scheduleLateInfo(shift(), [late], 15)).toEqual({
      rawMinutes: 40,
      violationMinutes: 40,
    });
  });

  // Grace is all-or-nothing: past it, the whole lateness counts, not the excess.
  it('derives all-or-nothing grace when nothing was stored', () => {
    const within = attendance({
      actualCheckinAt: new Date('2026-09-07T01:10:00.000Z'),
      lateMinutes: null,
    });
    expect(scheduleLateInfo(shift(), [within], 15).violationMinutes).toBe(0);

    const past = attendance({
      actualCheckinAt: new Date('2026-09-07T01:20:00.000Z'),
      lateMinutes: null,
    });
    expect(scheduleLateInfo(shift(), [past], 15).violationMinutes).toBe(20);
  });

  it('never counts an overtime shift as late', () => {
    const otShift = shift({ scheduleType: 'OVERTIME' });
    const late = attendance({
      actualCheckinAt: new Date('2026-09-07T03:00:00.000Z'),
      lateMinutes: 120,
    });
    expect(scheduleLateInfo(otShift, [late], 15).violationMinutes).toBe(0);
  });
});

describe('scheduleEarlyLeaveMinutes', () => {
  it('uses the latest checkout, not the first', () => {
    const out = attendance({
      actualCheckoutAt: new Date('2026-09-07T08:00:00.000Z'),
    });
    const backAgain = attendance({
      actualCheckoutAt: new Date('2026-09-07T09:30:00.000Z'),
    });
    // 30 minutes short, not 120 + 30.
    expect(scheduleEarlyLeaveMinutes(shift(), [out, backAgain])).toBe(30);
  });
});

/** The restoration rules exist so nobody is punished twice: when a penalty rule takes the money, the time it cost is given back. */
describe('toPayableSchedules', () => {
  const late = attendance({
    actualCheckinAt: new Date('2026-09-07T01:40:00.000Z'),
    lateMinutes: 40,
  });

  it('restores the whole shortfall when a late penalty will charge for it', () => {
    const [result] = toPayableSchedules([shift()], [late], {
      hasLatePenalty: true,
      hasEarlyLeavePenalty: false,
      graceMinutes: 15,
    });
    expect(result.actualWorkedMinutes).toBe(500);
    expect(result.payableMinutes).toBe(540);
  });

  it('restores only the grace when no penalty rule is configured', () => {
    const [result] = toPayableSchedules([shift()], [late], {
      hasLatePenalty: false,
      hasEarlyLeavePenalty: false,
      graceMinutes: 15,
    });
    // 500 worked + 0 restored (raw 40 − violation 40) - the lateness still costs time.
    expect(result.payableMinutes).toBe(500);
  });

  it('never pays for more than the shift is long', () => {
    const over = attendance({
      actualCheckinAt: new Date('2026-09-07T00:00:00.000Z'),
      actualCheckoutAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    const [result] = toPayableSchedules([shift()], [over], {
      hasLatePenalty: true,
      hasEarlyLeavePenalty: true,
      graceMinutes: 15,
    });
    expect(result.payableMinutes).toBe(540);
  });

  it('drops shifts nobody turned up to', () => {
    expect(
      toPayableSchedules([shift()], [], {
        hasLatePenalty: false,
        hasEarlyLeavePenalty: false,
        graceMinutes: 15,
      }),
    ).toHaveLength(0);
  });
});

describe('schedulePay', () => {
  it('pays a PAY_BY_SHIFT shift pro rata', () => {
    const line = schedulePay(
      payable({ payableMinutes: 270 }),
      rates(),
      null,
      settings,
    );
    expect(line.amount).toBe(200_000); // half a 400k shift
  });

  it('multiplies by the holiday rate', () => {
    const line = schedulePay(payable(), rates(), HOLIDAY, settings);
    expect(line.rate).toBe(3);
    expect(line.amount).toBe(1_200_000);
  });

  // Their period salary is prorated across the whole period instead - doing it per shift would make capping a day at one day's pay impossible.
  it('emits a zero-amount line for a FIXED employee normal shift', () => {
    const line = schedulePay(
      payable(),
      rates({ payType: 'FIXED' }),
      null,
      settings,
    );
    expect(line.amount).toBe(0);
    expect(line.payableMinutes).toBe(540);
  });

  it('prices overtime from the hourly equivalent', () => {
    const line = schedulePay(
      payable({ scheduleType: 'OVERTIME', payableMinutes: 120 }),
      rates({ payType: 'STANDARD_WORKING_DAY' }),
      null,
      settings,
    );
    // 500k/8h = 62.5k per hour × 2h × 1.5
    expect(line.amount).toBe(187_500);
  });
});

describe('fixedWorkedPay and workedDayCount', () => {
  const fixed = rates({ payType: 'FIXED' });

  it('caps a day at one day of salary however many shifts it holds', () => {
    const twoShifts = [
      payable({ id: 'a', payableMinutes: 480 }),
      payable({ id: 'b', payableMinutes: 480 }),
    ];
    expect(fixedWorkedPay(twoShifts, fixed, settings)).toBe(13_000_000 / 26);
  });

  it('prorates a part-worked day', () => {
    const half = [payable({ payableMinutes: 240 })];
    expect(fixedWorkedPay(half, fixed, settings)).toBeCloseTo(
      (13_000_000 / 26) * 0.5,
      6,
    );
  });

  it('counts one worked day per date and never counts overtime as a day', () => {
    expect(
      workedDayCount([
        payable({ id: 'a' }),
        payable({ id: 'b' }),
        payable({ id: 'c', scheduleType: 'OVERTIME' }),
        payable({ id: 'd', workDate: '2026-09-08' }),
      ]),
    ).toBe(2);
  });
});

describe('allocateLeaveDays', () => {
  const rostered = new Set(['2026-09-07', '2026-09-08', '2026-09-09']);
  const window = { fromKey: '2026-09-01', toKey: '2026-09-30' };

  it('spends paid days first, then unpaid', () => {
    const allocations = allocateLeaveDays(
      {
        startDate: new Date('2026-09-07'),
        endDate: new Date('2026-09-09'),
        paidLeaveDays: 2,
        unpaidLeaveDays: 1,
      },
      rostered,
      window,
    );
    expect(allocations).toEqual([
      { dateKey: '2026-09-07', leaveType: 'PAID', dayFraction: 1 },
      { dateKey: '2026-09-08', leaveType: 'PAID', dayFraction: 1 },
      { dateKey: '2026-09-09', leaveType: 'UNPAID', dayFraction: 1 },
    ]);
  });

  it('splits a single day between paid and unpaid', () => {
    const allocations = allocateLeaveDays(
      {
        startDate: new Date('2026-09-07'),
        endDate: new Date('2026-09-07'),
        paidLeaveDays: 0.5,
        unpaidLeaveDays: 0.5,
      },
      rostered,
      window,
    );
    expect(allocations).toEqual([
      { dateKey: '2026-09-07', leaveType: 'PAID', dayFraction: 0.5 },
      { dateKey: '2026-09-07', leaveType: 'UNPAID', dayFraction: 0.5 },
    ]);
  });

  // Leave over a day they weren't rostered doesn't spend the allowance on it.
  it('only consumes days the employee was rostered to work', () => {
    const allocations = allocateLeaveDays(
      {
        startDate: new Date('2026-09-05'),
        endDate: new Date('2026-09-09'),
        paidLeaveDays: 5,
        unpaidLeaveDays: 0,
      },
      rostered,
      window,
    );
    expect(allocations.map((a) => a.dateKey)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
    ]);
  });

  // A request straddling two periods spends its paid days once, from the request's start.
  it('allocates from the start of the request but reports only this window', () => {
    const allocations = allocateLeaveDays(
      {
        startDate: new Date('2026-09-07'),
        endDate: new Date('2026-09-09'),
        paidLeaveDays: 3,
        unpaidLeaveDays: 0,
      },
      rostered,
      { fromKey: '2026-09-09', toKey: '2026-09-30' },
    );
    expect(allocations).toEqual([
      { dateKey: '2026-09-09', leaveType: 'PAID', dayFraction: 1 },
    ]);
  });
});

describe('leave day amounts', () => {
  it('pays a PAY_BY_SHIFT leave day per shift that was rostered', () => {
    expect(paidLeaveDayAmount(rates(), settings, 2)).toBe(800_000);
  });

  it('pays a FIXED leave day as one standard day of the period salary', () => {
    expect(paidLeaveDayAmount(rates({ payType: 'FIXED' }), settings, 1)).toBe(
      13_000_000 / 26,
    );
  });

  // Shift-based schemes pay for shifts worked, so an unworked day already earns nothing and deducting again would charge for it twice.
  it('only deducts unpaid leave for FIXED', () => {
    expect(unpaidLeaveDayDeduction(rates(), settings)).toBe(0);
    expect(unpaidLeaveDayDeduction(rates({ payType: 'FIXED' }), settings)).toBe(
      13_000_000 / 26,
    );
  });
});

describe('deductions', () => {
  it('accepts the three shapes it can price and rejects the rest', () => {
    expect(
      isSupportedDeduction({ deductionType: 'FIXED', conditionType: null }),
    ).toBe(true);
    expect(
      isSupportedDeduction({
        deductionType: 'LATE',
        conditionType: 'BY_OCCURRENCE',
      }),
    ).toBe(true);
    expect(
      isSupportedDeduction({
        deductionType: 'LATE',
        conditionType: 'BY_SALARY_COEFFICIENT',
      }),
    ).toBe(false);
  });

  it('counts one unit per violation for BY_OCCURRENCE', () => {
    expect(
      deductionUnits(
        {
          deductionType: 'LATE',
          conditionType: 'BY_OCCURRENCE',
          blockMinutes: null,
        },
        [20, 45, 5],
      ),
    ).toBe(3);
  });

  // Rounding each violation separately is the point: rounding the total would let repeated small violations escape.
  it('rounds each violation up separately for BY_BLOCK', () => {
    expect(
      deductionUnits(
        { deductionType: 'LATE', conditionType: 'BY_BLOCK', blockMinutes: 15 },
        [16, 16],
      ),
    ).toBe(4);
  });

  it('charges a FIXED deduction once', () => {
    expect(
      deductionUnits(
        { deductionType: 'FIXED', conditionType: null, blockMinutes: null },
        [],
      ),
    ).toBe(1);
  });
});

// ─── Bonuses ─────────────────────────────────────────────────────────────────
// Neither codebase ever priced these, so there is nothing to port and the tests are the specification.

describe('tierFor', () => {
  const tiers: BonusTier[] = [
    {
      name: 'Bậc 1',
      fromValue: 3_000_000,
      rewardType: 'PERCENTAGE',
      rewardValue: 5,
      position: 0,
    },
    {
      name: 'Bậc 2',
      fromValue: 5_000_000,
      rewardType: 'PERCENTAGE',
      rewardValue: 14,
      position: 1,
    },
  ];

  it('picks the highest tier the revenue reaches', () => {
    expect(tierFor(tiers, 7_000_000)?.name).toBe('Bậc 2');
    expect(tierFor(tiers, 5_000_000)?.name).toBe('Bậc 2');
    expect(tierFor(tiers, 4_999_999)?.name).toBe('Bậc 1');
  });

  it('returns nothing when no tier is reached', () => {
    expect(tierFor(tiers, 2_999_999)).toBeNull();
  });

  it('reads a missing threshold as zero, not as "never applies"', () => {
    // A tier with no `fromValue` is a tier everybody clears; treating it as unreachable would be a rule that silently pays nobody.
    const open: BonusTier[] = [
      {
        name: 'Mọi mức',
        fromValue: null,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 100_000,
        position: 0,
      },
    ];
    expect(tierFor(open, 0)?.name).toBe('Mọi mức');
  });

  it('breaks a threshold tie on the order the owner arranged them in', () => {
    const duplicated: BonusTier[] = [
      {
        name: 'Đầu',
        fromValue: 1_000_000,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 10,
        position: 0,
      },
      {
        name: 'Cuối',
        fromValue: 1_000_000,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: 20,
        position: 1,
      },
    ];
    expect(tierFor(duplicated, 2_000_000)?.name).toBe('Cuối');
  });

  it('does not care what order the tiers arrive in', () => {
    expect(tierFor([...tiers].reverse(), 7_000_000)?.name).toBe('Bậc 2');
  });
});

describe('rewardOf', () => {
  const tier = (
    rewardType: string | null,
    rewardValue: number | null,
  ): BonusTier => ({
    name: null,
    fromValue: 0,
    rewardType,
    rewardValue,
    position: 0,
  });

  it('takes a percentage of the whole revenue, not of the part above the threshold', () => {
    expect(rewardOf(tier('PERCENTAGE', 14), 7_000_000)).toBe(980_000);
  });

  it('pays a fixed amount whatever the revenue', () => {
    expect(rewardOf(tier('FIXED_AMOUNT', 500_000), 7_000_000)).toBe(500_000);
  });

  it('refuses a reward type it does not understand', () => {
    // null, not 0: "we cannot price this" and "this is worth nothing" have to stay distinguishable.
    expect(rewardOf(tier('BY_SALARY_COEFFICIENT', 3), 7_000_000)).toBeNull();
    expect(rewardOf(tier(null, 3), 7_000_000)).toBeNull();
  });
});

describe('payBonuses', () => {
  const revenue = (
    gross: number,
    net = gross,
    collected = gross,
  ): RevenueFigures => ({
    gross,
    net,
    collected,
  });

  const commission: BonusRule = {
    bonusType: 'EMPLOYEE_REVENUE',
    calculationType: 'NET_REVENUE',
    enable: true,
    tiers: [
      {
        name: 'Bậc 1',
        fromValue: 3_000_000,
        rewardType: 'PERCENTAGE',
        rewardValue: 5,
        position: 0,
      },
      {
        name: 'Bậc 2',
        fromValue: 5_000_000,
        rewardType: 'PERCENTAGE',
        rewardValue: 14,
        position: 1,
      },
    ],
  };

  const run = (input: Partial<Parameters<typeof payBonuses>[0]> = {}) =>
    payBonuses({
      rules: [commission],
      employee: revenue(7_000_000),
      branch: revenue(50_000_000),
      hasBranch: true,
      incomeBeforeBonus: 4_000_000,
      ...input,
    });

  it('pays the highest tier reached, flat, over the whole revenue', () => {
    const result = run();
    expect(result.bonus).toBe(980_000);
    // Not 380_000 (progressive brackets) and not 1_330_000 (every tier summed): the owner chose "highest tier wins" over both readings.
    expect(result.bonus).not.toBe(380_000);
    expect(result.bonus).not.toBe(1_330_000);
    expect(result.lines).toEqual([
      {
        bonusType: 'EMPLOYEE_REVENUE',
        calculationType: 'NET_REVENUE',
        revenue: 7_000_000,
        tierName: 'Bậc 2',
        fromValue: 5_000_000,
        rewardType: 'PERCENTAGE',
        rewardValue: 14,
        amount: 980_000,
      },
    ]);
  });

  it('still writes a line when no tier was reached', () => {
    // A missing bonus row reads as a bug; a zero one reads as "you did not reach 3 triệu".
    const result = run({ employee: revenue(1_000_000) });
    expect(result.bonus).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      revenue: 1_000_000,
      tierName: null,
      amount: 0,
    });
  });

  it('ignores a rule that is switched off', () => {
    expect(run({ rules: [{ ...commission, enable: false }] })).toEqual({
      bonus: 0,
      lines: [],
      warnings: [],
    });
  });

  it('measures each rule against the figure its calculationType names', () => {
    const figures = revenue(9_000_000, 7_000_000, 5_000_000);
    const of = (calculationType: string) =>
      payBonuses({
        rules: [{ ...commission, calculationType }],
        employee: figures,
        branch: NO_REVENUE,
        hasBranch: true,
        incomeBeforeBonus: 0,
      }).lines[0].revenue;

    expect(of('GROSS_REVENUE')).toBe(9_000_000);
    expect(of('NET_REVENUE')).toBe(7_000_000);
    expect(of('COLLECTED_REVENUE')).toBe(5_000_000);
  });

  it('measures a branch bonus against the branch, not the employee', () => {
    const result = run({
      rules: [{ ...commission, bonusType: 'BRANCH_REVENUE' }],
    });
    expect(result.lines[0].revenue).toBe(50_000_000);
    expect(result.bonus).toBe(7_000_000);
  });

  it('refuses a branch bonus for somebody who has no branch', () => {
    // Posted at a warehouse or nowhere; falling back to the employee's own takings, or to some branch, would be inventing the number.
    const result = run({
      rules: [{ ...commission, bonusType: 'BRANCH_REVENUE' }],
      hasBranch: false,
    });
    expect(result.bonus).toBe(0);
    expect(result.lines).toHaveLength(0);
    expect(result.warnings).toEqual(['BRANCH_BONUS_WITHOUT_BRANCH']);
  });

  it('reports a rule it cannot read instead of pricing it at zero', () => {
    const unreadable = run({
      rules: [
        { ...commission, bonusType: 'SOMETHING_NEW' },
        { ...commission, calculationType: 'PROFIT' },
      ],
    });
    expect(unreadable.bonus).toBe(0);
    expect(unreadable.warnings.sort()).toEqual([
      'UNSUPPORTED_BONUS_CALCULATION',
      'UNSUPPORTED_BONUS_TYPE',
    ]);
  });

  it('reports an unreadable reward but keeps the line, so the tier is visible', () => {
    const result = run({
      rules: [
        {
          ...commission,
          tiers: [
            {
              name: 'Bậc lạ',
              fromValue: 0,
              rewardType: 'BY_SALARY_COEFFICIENT',
              rewardValue: 3,
              position: 0,
            },
          ],
        },
      ],
    });
    expect(result.bonus).toBe(0);
    expect(result.warnings).toEqual(['UNSUPPORTED_BONUS_REWARD']);
    expect(result.lines[0]).toMatchObject({ tierName: 'Bậc lạ', amount: 0 });
  });

  it('adds up several rules', () => {
    const result = run({
      rules: [
        commission,
        {
          bonusType: 'BRANCH_REVENUE',
          calculationType: 'NET_REVENUE',
          enable: true,
          tiers: [
            {
              name: 'Chi nhánh',
              fromValue: 10_000_000,
              rewardType: 'FIXED_AMOUNT',
              rewardValue: 300_000,
              position: 0,
            },
          ],
        },
      ],
    });
    expect(result.bonus).toBe(980_000 + 300_000);
  });

  // ── The income floor ──────────────────────────────────────────────────────

  const guarantee = (amount: number): BonusRule => ({
    bonusType: 'MINIMUM_AVENUE_INCOME',
    calculationType: 'NET_REVENUE',
    enable: true,
    tiers: [
      {
        name: 'Đảm bảo',
        fromValue: 0,
        rewardType: 'FIXED_AMOUNT',
        rewardValue: amount,
        position: 0,
      },
    ],
  });

  it('tops pay up to the floor it guarantees', () => {
    const result = run({
      rules: [guarantee(6_000_000)],
      incomeBeforeBonus: 4_000_000,
    });
    expect(result.bonus).toBe(2_000_000);
  });

  it('pays nothing when the floor is already cleared', () => {
    const result = run({
      rules: [guarantee(6_000_000)],
      incomeBeforeBonus: 8_000_000,
    });
    expect(result.bonus).toBe(0);
    expect(result.lines[0].amount).toBe(0);
  });

  it('applies the floor AFTER the revenue bonuses, not before', () => {
    // This ordering is the whole rule: income 4tr + commission 980k against a 6tr floor tops up by 1.02tr, so take-home lands exactly on 6tr. Evaluating the floor first would pay 6.98tr.
    const result = run({
      rules: [commission, guarantee(6_000_000)],
      incomeBeforeBonus: 4_000_000,
    });
    expect(result.bonus).toBe(2_000_000);
    expect(4_000_000 + result.bonus).toBe(6_000_000);
    expect(result.bonus).not.toBe(2_980_000);

    const floorLine = result.lines.find(
      (line) => line.bonusType === 'MINIMUM_AVENUE_INCOME',
    );
    expect(floorLine?.amount).toBe(1_020_000);
  });

  it('does not care what order the rules are configured in', () => {
    const forwards = run({ rules: [commission, guarantee(6_000_000)] });
    const backwards = run({ rules: [guarantee(6_000_000), commission] });
    expect(backwards.bonus).toBe(forwards.bonus);
  });

  it('reads a percentage guarantee as a promised income, not as an amount to add', () => {
    // 20% of 7tr revenue is 1.4tr promised; income is already 1tr, so 400k tops it up - not 1.4tr, which is what treating it as a commission would pay.
    const result = run({
      rules: [
        {
          bonusType: 'MINIMUM_AVENUE_INCOME',
          calculationType: 'NET_REVENUE',
          enable: true,
          tiers: [
            {
              name: 'Đảm bảo',
              fromValue: 0,
              rewardType: 'PERCENTAGE',
              rewardValue: 20,
              position: 0,
            },
          ],
        },
      ],
      incomeBeforeBonus: 1_000_000,
    });
    expect(result.bonus).toBe(400_000);
  });

  it('never returns a negative bonus', () => {
    const result = run({
      rules: [
        {
          ...commission,
          tiers: [
            {
              name: 'Âm',
              fromValue: 0,
              rewardType: 'FIXED_AMOUNT',
              rewardValue: -500_000,
              position: 0,
            },
          ],
        },
      ],
    });
    expect(result.bonus).toBe(0);
  });
});
