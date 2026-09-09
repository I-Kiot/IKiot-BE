import { FlowType } from '../stats/stats.constants';

/** The arithmetic behind "the till is short", pure so it can be settled without a database. Every count is a link in the chain `openingAmount → shiftLog… → finalAmount`, each checked as `counted − (previous count + net cash in between)`, so the segment variances sum to the session variance - the day is short by X, and here is which shift lost it. Cash only; the caller filters. */

// Kept as a local literal rather than importing ShiftLogType: that module pulls in the timezone constant, and this one stays pure arithmetic. Asserted against the real enum in the spec.
const ShiftLogStart = 'START';

/** Which link of the chain a segment ends at - i.e. who is answerable for it. */
export const CashSegmentKind = {
  /** Trading day opened → the first cashier took the drawer. Nobody had custody yet. */
  OPENING: 'OPENING',
  /** One cashier held the drawer, from their `START` to their `END`. */
  SHIFT: 'SHIFT',
  /** Between one cashier handing back and the next taking over - nobody had custody. */
  GAP: 'GAP',
  /** The last `END` → the manager's closing count. */
  CLOSING: 'CLOSING',
} as const;

export type CashSegmentKind =
  (typeof CashSegmentKind)[keyof typeof CashSegmentKind];

/** One `CashFlow` row, already narrowed to cash and to this branch and trading day. */
export interface CashMovement {
  at: Date;
  /** `INCOME` | `EXPENSE` - the sign is applied here, not by the caller. */
  flowType: string;
  amount: number;
}

/** The subset of a shift log this math needs. */
export interface ShiftLogEntry {
  type: string;
  staffId: string;
  amount: number;
  loggedAt: Date;
}

export interface ReconcileInput {
  openingAmount: number;
  /** The manager's closing count, or `null` while the session is still open. */
  finalAmount: number | null;
  /** Chronological, as `SESSION_INCLUDE` already orders them. */
  shiftLogs: readonly ShiftLogEntry[];
  /** Every cash movement of the trading day, in any order. */
  movements: readonly CashMovement[];
}

export interface CashSegment {
  kind: CashSegmentKind;
  /** Who had custody. `null` for OPENING, GAP and CLOSING - that is the point of them. */
  staffId: string | null;
  /** `null` = the start of the trading day (nothing was counted before this). */
  from: Date | null;
  /** `null` = still running: an open shift, or a session nobody has closed yet. */
  to: Date | null;
  /** The count this segment starts from - the previous link of the chain. */
  openingCount: number;
  /** The count it ends at, or `null` when the segment has not been closed by a count. */
  closingCount: number | null;
  cashIn: number;
  cashOut: number;
  netCash: number;
  /** `openingCount + netCash` - what should have been in the drawer at `to`. */
  expected: number;
  /** `closingCount − expected`. Negative is short, positive is over. `null` if unclosed. */
  variance: number | null;
  movementCount: number;
}

export interface Reconciliation {
  openingAmount: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  /** `openingAmount + netCash` - what the drawer should hold at the end of the day. */
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
  movementCount: number;
  segments: CashSegment[];
}

/** Whole đồng to the cent: amounts are integers, but `CashFlow.amount` is `Decimal(14,2)` read through `Number()`, so a few hundred of them can land on 1234.9999999999998. */
function money(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  // `-0` is a real JS value that a strict comparison in a client does not treat as 0.
  return rounded === 0 ? 0 : rounded;
}

/** `INCOME` adds to the drawer, anything else takes from it. */
export function signedAmount(movement: CashMovement): number {
  return movement.flowType === FlowType.INCOME
    ? movement.amount
    : -movement.amount;
}

/** Splits the trading day into segments at every counted amount and attributes each movement to the segment it falls in; a movement exactly on a boundary belongs to the later segment, so it lands on the incoming cashier rather than being left to sort order. */
export function reconcileSession(input: ReconcileInput): Reconciliation {
  const logs = [...input.shiftLogs].sort(
    (a, b) => a.loggedAt.getTime() - b.loggedAt.getTime(),
  );
  const movements = [...input.movements].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  const segments: CashSegment[] = [];
  let cursor = 0; // how far through `movements` we have got - each is used exactly once
  let openingCount = input.openingAmount;

  for (let i = 0; i <= logs.length; i++) {
    const previous = i === 0 ? null : logs[i - 1];
    const next = i < logs.length ? logs[i] : null;

    let cashIn = 0;
    let cashOut = 0;
    let movementCount = 0;
    while (cursor < movements.length) {
      const movement = movements[cursor];
      // The last segment has no upper bound: it runs to the end of the trading day.
      if (next && movement.at.getTime() >= next.loggedAt.getTime()) break;
      if (movement.flowType === FlowType.INCOME) cashIn += movement.amount;
      else cashOut += movement.amount;
      movementCount++;
      cursor++;
    }

    const netCash = cashIn - cashOut;
    const expected = openingCount + netCash;
    const closingCount = next ? next.amount : input.finalAmount;

    segments.push({
      kind: segmentKind(previous, next),
      // Custody belongs to whoever filed the START that opened the segment; after an END nobody holds the drawer, which is why GAP is its own kind.
      staffId: previous?.type === ShiftLogStart ? previous.staffId : null,
      from: previous ? previous.loggedAt : null,
      to: next ? next.loggedAt : null,
      openingCount: money(openingCount),
      closingCount: closingCount === null ? null : money(closingCount),
      cashIn: money(cashIn),
      cashOut: money(cashOut),
      netCash: money(netCash),
      expected: money(expected),
      variance: closingCount === null ? null : money(closingCount - expected),
      movementCount,
    });

    if (closingCount === null) break;
    openingCount = closingCount;
  }

  const cashIn = movements
    .filter((m) => m.flowType === FlowType.INCOME)
    .reduce((sum, m) => sum + m.amount, 0);
  const cashOut = movements
    .filter((m) => m.flowType !== FlowType.INCOME)
    .reduce((sum, m) => sum + m.amount, 0);
  const netCash = cashIn - cashOut;
  const expectedClosing = input.openingAmount + netCash;

  return {
    openingAmount: money(input.openingAmount),
    cashIn: money(cashIn),
    cashOut: money(cashOut),
    netCash: money(netCash),
    expectedClosing: money(expectedClosing),
    countedClosing:
      input.finalAmount === null ? null : money(input.finalAmount),
    variance:
      input.finalAmount === null
        ? null
        : money(input.finalAmount - expectedClosing),
    movementCount: movements.length,
    segments,
  };
}

/** `next` separates the last stretch of the day from an ordinary lull: both follow an END, but only the one with nothing after it ends at the manager's closing count, where a recount discrepancy shows up. */
function segmentKind(
  previous: ShiftLogEntry | null,
  next: ShiftLogEntry | null,
): CashSegmentKind {
  if (!previous) return CashSegmentKind.OPENING;
  if (previous.type === ShiftLogStart) return CashSegmentKind.SHIFT;
  return next ? CashSegmentKind.GAP : CashSegmentKind.CLOSING;
}

/** The one-line version for a list of sessions: the same top-level numbers from pre-aggregated sums, so a 90-day report is one grouped query rather than 90 row-by-row attributions. */
export function summarizeVariance(input: {
  openingAmount: number;
  finalAmount: number | null;
  cashIn: number;
  cashOut: number;
}): {
  openingAmount: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  expectedClosing: number;
  countedClosing: number | null;
  variance: number | null;
} {
  const netCash = input.cashIn - input.cashOut;
  const expectedClosing = input.openingAmount + netCash;
  return {
    openingAmount: money(input.openingAmount),
    cashIn: money(input.cashIn),
    cashOut: money(input.cashOut),
    netCash: money(netCash),
    expectedClosing: money(expectedClosing),
    countedClosing:
      input.finalAmount === null ? null : money(input.finalAmount),
    variance:
      input.finalAmount === null
        ? null
        : money(input.finalAmount - expectedClosing),
  };
}
