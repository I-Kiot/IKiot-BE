import type { CashSegment } from './cash-reconciliation';
import { summarizeByCashier } from './cashier-summary';

const seg = (over: Partial<CashSegment>): CashSegment => ({
  kind: 'SHIFT',
  staffId: 'A',
  from: null,
  to: null,
  openingCount: 0,
  closingCount: 0,
  cashIn: 0,
  cashOut: 0,
  netCash: 0,
  expected: 0,
  variance: 0,
  movementCount: 0,
  ...over,
});

describe('summarizeByCashier', () => {
  it('adds up each cashier across sessions and puts the biggest shortfall first', () => {
    const { rows } = summarizeByCashier([
      {
        sessionId: 's1',
        segments: [
          seg({ kind: 'OPENING', staffId: null, variance: 0 }),
          seg({ staffId: 'A', cashIn: 2_000_000, variance: 0 }),
          seg({
            staffId: 'B',
            cashIn: 3_000_000,
            cashOut: 300_000,
            variance: -50_000,
          }),
        ],
      },
      {
        sessionId: 's2',
        segments: [
          seg({ staffId: 'A', cashIn: 1_000_000, variance: 20_000 }),
          seg({ staffId: 'A', cashIn: 500_000, variance: -10_000 }),
        ],
      },
    ]);
    expect(rows.map((r) => r.staffId)).toEqual(['B', 'A']);
    expect(rows[1]).toMatchObject({
      staffId: 'A',
      shifts: 3,
      sessions: 2,
      cashIn: 3_500_000,
      variance: 10_000,
      shortShifts: 1,
      shortfall: -10_000,
      overShifts: 1,
      overage: 20_000,
    });
    expect(rows[0]).toMatchObject({
      shifts: 1,
      sessions: 1,
      shortfall: -50_000,
    });
  });

  it('counts a shift still being held without blaming anyone', () => {
    const { rows } = summarizeByCashier([
      {
        sessionId: 's1',
        segments: [seg({ staffId: 'A', variance: null, cashIn: 100 })],
      },
    ]);
    expect(rows[0]).toMatchObject({
      shifts: 1,
      openShifts: 1,
      variance: 0,
      cashIn: 100,
    });
  });

  it('keeps variance nobody was holding the drawer for apart, by kind', () => {
    const { rows, unattributed } = summarizeByCashier([
      {
        sessionId: 's1',
        segments: [
          seg({ kind: 'OPENING', staffId: null, variance: -1_000 }),
          seg({ kind: 'GAP', staffId: null, variance: 0 }),
          seg({ kind: 'CLOSING', staffId: null, variance: -5_000 }),
        ],
      },
      {
        sessionId: 's2',
        segments: [seg({ kind: 'CLOSING', staffId: null, variance: 2_000 })],
      },
    ]);
    expect(rows).toEqual([]);
    expect(unattributed).toEqual([
      { kind: 'OPENING', count: 1, variance: -1_000 },
      { kind: 'CLOSING', count: 2, variance: -3_000 },
    ]);
  });
});
