import { ShiftLogType } from './cash-drawer.constants';
import {
  CashSegmentKind,
  reconcileSession,
  signedAmount,
  summarizeVariance,
  type CashMovement,
  type ReconcileInput,
  type ShiftLogEntry,
} from './cash-reconciliation';

const at = (hhmm: string) => new Date(`2026-08-26T${hhmm}:00.000Z`);

const sale = (hhmm: string, amount: number): CashMovement => ({
  at: at(hhmm),
  flowType: 'INCOME',
  amount,
});

const payout = (hhmm: string, amount: number): CashMovement => ({
  at: at(hhmm),
  flowType: 'EXPENSE',
  amount,
});

const start = (
  hhmm: string,
  staffId: string,
  amount: number,
): ShiftLogEntry => ({
  type: ShiftLogType.START,
  staffId,
  amount,
  loggedAt: at(hhmm),
});

const end = (hhmm: string, staffId: string, amount: number): ShiftLogEntry => ({
  type: ShiftLogType.END,
  staffId,
  amount,
  loggedAt: at(hhmm),
});

const run = (input: Partial<ReconcileInput> = {}) =>
  reconcileSession({
    openingAmount: 500_000,
    finalAmount: null,
    shiftLogs: [],
    movements: [],
    ...input,
  });

describe('reconcileSession', () => {
  it('reports a balanced day as zero, not as a rounding artefact', () => {
    const result = run({
      finalAmount: 1_500_000,
      shiftLogs: [
        start('01:00', 'anh', 500_000),
        end('09:00', 'anh', 1_500_000),
      ],
      movements: [sale('02:00', 400_000), sale('03:00', 600_000)],
    });

    expect(result.cashIn).toBe(1_000_000);
    expect(result.cashOut).toBe(0);
    expect(result.expectedClosing).toBe(1_500_000);
    expect(result.countedClosing).toBe(1_500_000);
    expect(result.variance).toBe(0);
  });

  it('subtracts change handed back, not just sales rung up', () => {
    // A cash sale with change writes two rows (INCOME of what was handed over, EXPENSE of the change); counting only the INCOME leg would report every till as over.
    const result = run({
      finalAmount: 600_000,
      movements: [sale('02:00', 200_000), payout('02:00', 100_000)],
    });

    expect(result.cashIn).toBe(200_000);
    expect(result.cashOut).toBe(100_000);
    expect(result.netCash).toBe(100_000);
    expect(result.expectedClosing).toBe(600_000);
    expect(result.variance).toBe(0);
  });

  it('names the shift a shortfall happened on', () => {
    const result = run({
      finalAmount: 1_450_000,
      shiftLogs: [
        start('01:00', 'anh', 500_000),
        end('05:00', 'anh', 900_000),
        start('05:00', 'binh', 900_000),
        end('09:00', 'binh', 1_450_000),
      ],
      // Anh takes 400k of sales and hands over exactly right; Binh takes 600k and is 50k short at handback.
      movements: [sale('02:00', 400_000), sale('06:00', 600_000)],
    });

    expect(result.variance).toBe(-50_000);

    const shifts = result.segments.filter(
      (segment) => segment.kind === CashSegmentKind.SHIFT,
    );
    expect(shifts).toHaveLength(2);
    expect(shifts[0]).toMatchObject({ staffId: 'anh', variance: 0 });
    expect(shifts[1]).toMatchObject({ staffId: 'binh', variance: -50_000 });
  });

  it('attributes a movement on a handover boundary to the incoming cashier', () => {
    // Exactly on the boundary is the case a sort order would silently decide; `from <= at` makes it the incoming shift's.
    const result = run({
      finalAmount: 900_000,
      shiftLogs: [
        start('01:00', 'anh', 500_000),
        end('05:00', 'anh', 500_000),
        start('05:00', 'binh', 500_000),
        end('09:00', 'binh', 900_000),
      ],
      movements: [sale('05:00', 400_000)],
    });

    const shifts = result.segments.filter(
      (segment) => segment.kind === CashSegmentKind.SHIFT,
    );
    expect(shifts[0]).toMatchObject({ staffId: 'anh', movementCount: 0 });
    expect(shifts[1]).toMatchObject({
      staffId: 'binh',
      movementCount: 1,
      cashIn: 400_000,
      variance: 0,
    });
  });

  it('gives money moving while nobody held the drawer its own segment', () => {
    const result = run({
      finalAmount: 500_000,
      shiftLogs: [
        start('01:00', 'anh', 500_000),
        end('05:00', 'anh', 500_000),
        start('07:00', 'binh', 500_000),
        end('09:00', 'binh', 500_000),
      ],
      // 06:00 is between a handback and the next take: no cashier is answerable for it.
      movements: [sale('06:00', 300_000)],
    });

    const gaps = result.segments.filter(
      (segment) => segment.kind === CashSegmentKind.GAP,
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      staffId: null,
      cashIn: 300_000,
      variance: -300_000,
    });
  });

  it('has an OPENING segment before anyone takes the drawer and a CLOSING one after', () => {
    const result = run({
      finalAmount: 500_000,
      shiftLogs: [start('01:00', 'anh', 500_000), end('09:00', 'anh', 500_000)],
    });

    expect(result.segments.map((segment) => segment.kind)).toEqual([
      CashSegmentKind.OPENING,
      CashSegmentKind.SHIFT,
      CashSegmentKind.CLOSING,
    ]);
    expect(result.segments[0]).toMatchObject({ from: null, staffId: null });
    expect(result.segments.at(-1)).toMatchObject({ to: null, staffId: null });
  });

  it('catches the manager recounting a different total than the cashier handed over', () => {
    // The CLOSING segment makes this visible: no cash moved after the last END, so any difference is the two counts disagreeing.
    const result = run({
      finalAmount: 480_000,
      shiftLogs: [start('01:00', 'anh', 500_000), end('09:00', 'anh', 500_000)],
    });

    const closing = result.segments.at(-1)!;
    expect(closing.kind).toBe(CashSegmentKind.CLOSING);
    expect(closing).toMatchObject({
      openingCount: 500_000,
      closingCount: 480_000,
      netCash: 0,
      variance: -20_000,
    });
  });

  it('leaves an unfinished session unjudged rather than reporting it short', () => {
    // A drawer still in someone's hands has no closing count; defaulting it to zero would report every open till as short by its whole float.
    const result = run({
      finalAmount: null,
      shiftLogs: [start('01:00', 'anh', 500_000)],
      movements: [sale('02:00', 400_000)],
    });

    expect(result.countedClosing).toBeNull();
    expect(result.variance).toBeNull();
    expect(result.expectedClosing).toBe(900_000);

    const live = result.segments.at(-1)!;
    expect(live).toMatchObject({
      kind: CashSegmentKind.SHIFT,
      staffId: 'anh',
      to: null,
      closingCount: null,
      variance: null,
      expected: 900_000,
    });
  });

  it('stops the chain at the first uncounted link', () => {
    // Nothing after an unknown count can be computed, so there is one `null` segment rather than a tail of invented ones.
    const result = run({ finalAmount: null });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].variance).toBeNull();
  });

  it('accounts for every movement exactly once', () => {
    const movements = [
      sale('00:30', 100_000),
      sale('02:00', 200_000),
      sale('06:00', 300_000),
      payout('08:00', 50_000),
      sale('10:00', 400_000),
    ];
    const result = run({
      finalAmount: 1_450_000,
      shiftLogs: [
        start('01:00', 'anh', 600_000),
        end('05:00', 'anh', 800_000),
        start('07:00', 'binh', 800_000),
        end('09:00', 'binh', 1_050_000),
      ],
      movements,
    });

    const counted = result.segments.reduce((n, s) => n + s.movementCount, 0);
    expect(counted).toBe(movements.length);
    expect(result.movementCount).toBe(movements.length);
  });

  it('sorts movements it is handed in any order', () => {
    const ordered = run({
      finalAmount: 900_000,
      shiftLogs: [start('01:00', 'anh', 500_000), end('09:00', 'anh', 900_000)],
      movements: [sale('02:00', 100_000), sale('06:00', 300_000)],
    });
    const shuffled = run({
      finalAmount: 900_000,
      shiftLogs: [start('01:00', 'anh', 500_000), end('09:00', 'anh', 900_000)],
      movements: [sale('06:00', 300_000), sale('02:00', 100_000)],
    });

    expect(shuffled).toEqual(ordered);
  });

  // The property the whole report rests on: if the segment variances and the session variance disagree, the breakdown is decoration.
  it.each([
    ['a clean day', 1_500_000, 0],
    ['a shortfall', 1_450_000, -50_000],
    ['an overage', 1_530_000, 30_000],
  ])(
    'segment variances sum to the session variance (%s)',
    (_label, finalAmount, expected) => {
      const result = run({
        finalAmount,
        shiftLogs: [
          start('01:00', 'anh', 500_000),
          end('05:00', 'anh', 900_000),
          start('07:00', 'binh', 900_000),
          end('09:00', 'binh', 1_500_000),
        ],
        movements: [sale('02:00', 400_000), sale('08:00', 600_000)],
      });

      const summed = result.segments.reduce((n, s) => n + (s.variance ?? 0), 0);
      expect(result.variance).toBe(expected);
      expect(summed).toBe(result.variance);
    },
  );

  it('does not let floating-point sums invent a variance', () => {
    // Decimal(14,2) comes back through Number(), so hundreds of `.10`s add up to 1234.9999999999998 unless the boundary rounds.
    const movements = Array.from({ length: 300 }, (_unused, index) =>
      sale('02:00', 0.1 + index * 0),
    );
    const result = run({
      openingAmount: 0,
      finalAmount: 30,
      movements,
    });

    expect(result.cashIn).toBe(30);
    expect(result.variance).toBe(0);
  });
});

describe('signedAmount', () => {
  it('adds income to the drawer and takes expense out of it', () => {
    expect(signedAmount(sale('02:00', 100))).toBe(100);
    expect(signedAmount(payout('02:00', 100))).toBe(-100);
  });
});

describe('summarizeVariance', () => {
  it('agrees with the full reconciliation on the totals', () => {
    const detail = run({
      finalAmount: 1_450_000,
      shiftLogs: [
        start('01:00', 'anh', 500_000),
        end('09:00', 'anh', 1_450_000),
      ],
      movements: [sale('02:00', 1_000_000), payout('03:00', 50_000)],
    });
    const summary = summarizeVariance({
      openingAmount: 500_000,
      finalAmount: 1_450_000,
      cashIn: 1_000_000,
      cashOut: 50_000,
    });

    expect(summary).toEqual({
      openingAmount: detail.openingAmount,
      cashIn: detail.cashIn,
      cashOut: detail.cashOut,
      netCash: detail.netCash,
      expectedClosing: detail.expectedClosing,
      countedClosing: detail.countedClosing,
      variance: detail.variance,
    });
  });

  it('leaves an unfinished session unjudged, like the full reconciliation', () => {
    expect(
      summarizeVariance({
        openingAmount: 500_000,
        finalAmount: null,
        cashIn: 1_000_000,
        cashOut: 0,
      }),
    ).toMatchObject({
      countedClosing: null,
      variance: null,
      expectedClosing: 1_500_000,
    });
  });
});
