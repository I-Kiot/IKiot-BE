import {
  bookClosing,
  bookOpening,
  keptAmountOf,
  openingAdjustment,
} from './drawer-cash-flow';

const ctx = {
  tenantId: 't1',
  branchId: 'b1',
  sessionId: 's1',
  actorId: 'u1',
};

/** Giả transaction: chỉ ghi lại các dòng `createMany` nhận được. */
function fakeTx() {
  const rows: Record<string, unknown>[] = [];
  const tx = {
    cashFlow: {
      createMany: ({ data }: { data: Record<string, unknown>[] }) => {
        rows.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
  };
  return { tx: tx as never, rows };
}

const pick = (rows: Record<string, unknown>[]) =>
  rows.map((r) => [r.category, r.fund, r.flowType, r.amount]);

describe('openingAdjustment', () => {
  it('records nothing when the count matches what was left', () => {
    expect(openingAdjustment(1_000_000, 1_000_000)).toEqual({
      ownerTopUp: 0,
      shortage: 0,
    });
  });
  it('reads more than was left as the owner topping up', () => {
    expect(openingAdjustment(2_000_000, 1_000_000).ownerTopUp).toBe(1_000_000);
  });
  it('reads less than was left as an overnight shortage', () => {
    expect(openingAdjustment(900_000, 1_000_000).shortage).toBe(100_000);
  });
});

describe('keptAmountOf', () => {
  it('is the count minus what the owner took', () => {
    expect(
      keptAmountOf({ finalLogAmount: 5_450_000, withdrawnAmount: 4_450_000 }),
    ).toBe(1_000_000);
  });
  it('treats a session closed before withdrawals existed as leaving nothing', () => {
    expect(
      keptAmountOf({ finalLogAmount: 5_000_000, withdrawnAmount: null }),
    ).toBe(0);
  });
});

describe('bookOpening', () => {
  it('writes the float as a transfer owner -> drawer on the first opening', async () => {
    const { tx, rows } = fakeTx();
    await bookOpening(tx, ctx, {
      openingAmount: 1_000_000,
      keptAmount: 0,
      at: new Date(),
    });
    expect(pick(rows)).toEqual([
      ['FUND_TRANSFER_OUT', 'OWNER', 'EXPENSE', 1_000_000],
      ['FUND_TRANSFER_IN', 'DRAWER', 'INCOME', 1_000_000],
    ]);
    expect(rows.every((r) => r.cashDrawerSessionId === 's1')).toBe(true);
    expect(rows.every((r) => r.paymentMethod === 'CASH')).toBe(true);
  });
  it('writes nothing when the float was left from the previous session', async () => {
    const { tx, rows } = fakeTx();
    await bookOpening(tx, ctx, {
      openingAmount: 1_000_000,
      keptAmount: 1_000_000,
      at: new Date(),
    });
    expect(rows).toEqual([]);
  });
  it('writes an overnight shortage', async () => {
    const { tx, rows } = fakeTx();
    await bookOpening(tx, ctx, {
      openingAmount: 900_000,
      keptAmount: 1_000_000,
      at: new Date(),
    });
    expect(pick(rows)).toEqual([
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 100_000],
    ]);
  });
});

describe('bookClosing', () => {
  it('books the scenario: 50k short, owner takes 4.45m, 1m stays', async () => {
    const { tx, rows } = fakeTx();
    const at = new Date('2026-11-27T15:00:00Z');
    await bookClosing(tx, ctx, {
      expectedAmount: 5_500_000,
      countedAmount: 5_450_000,
      withdrawnAmount: 4_450_000,
      at,
    });
    expect(pick(rows)).toEqual([
      ['DRAWER_SHORTAGE', 'DRAWER', 'EXPENSE', 50_000],
      ['FUND_TRANSFER_OUT', 'DRAWER', 'EXPENSE', 4_450_000],
      ['FUND_TRANSFER_IN', 'OWNER', 'INCOME', 4_450_000],
    ]);
    // Rút sau khi đếm.
    expect((rows[1].createdAt as Date).getTime()).toBeGreaterThan(at.getTime());
  });
  it('books a surplus and nothing else when the owner takes nothing', async () => {
    const { tx, rows } = fakeTx();
    await bookClosing(tx, ctx, {
      expectedAmount: 1_000_000,
      countedAmount: 1_020_000,
      withdrawnAmount: 0,
      at: new Date(),
    });
    expect(pick(rows)).toEqual([
      ['DRAWER_SURPLUS', 'DRAWER', 'INCOME', 20_000],
    ]);
  });
  it('writes nothing when the count matches and nothing is withdrawn', async () => {
    const { tx, rows } = fakeTx();
    await bookClosing(tx, ctx, {
      expectedAmount: 1_000_000,
      countedAmount: 1_000_000,
      withdrawnAmount: 0,
      at: new Date(),
    });
    expect(rows).toEqual([]);
  });
});
