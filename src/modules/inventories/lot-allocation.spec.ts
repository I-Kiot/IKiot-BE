import {
  averageUnitCost,
  planArrivalAllocation,
  planDraw,
  planReturn,
  runningBalances,
} from './lot-allocation';

const day = (n: number) => new Date(Date.UTC(2026, 9, n));
const lot = (
  id: string,
  remainingQuantity: number,
  receivedOn: number,
  orderItemId: string | null = null,
) => ({ id, remainingQuantity, receivedAt: day(receivedOn), orderItemId });

// FIFO decides the cost of every unit sold; getting it wrong silently misstates margins.
describe('planDraw', () => {
  it('draws the oldest lot first, spilling into the next', () => {
    const lots = [lot('new', 5, 3), lot('old', 2, 1), lot('mid', 4, 2)];
    expect(planDraw(lots, 5)).toEqual([
      { lotId: 'old', quantity: 2 },
      { lotId: 'mid', quantity: 3 },
    ]);
  });

  it('breaks a receivedAt tie by id, so the same rows always give the same answer', () => {
    const lots = [lot('b', 1, 1), lot('a', 1, 1)];
    expect(planDraw(lots, 1)).toEqual([{ lotId: 'a', quantity: 1 }]);
  });

  it('takes a line its own made-to-order lot before any shared one, however old', () => {
    const lots = [lot('shared', 5, 1), lot('mine', 1, 9, 'line-1')];
    expect(planDraw(lots, 2, 'line-1')).toEqual([
      { lotId: 'mine', quantity: 1 },
      { lotId: 'shared', quantity: 1 },
    ]);
  });

  it("never touches a lot made for somebody else's line", () => {
    const lots = [lot('theirs', 5, 1, 'line-2'), lot('shared', 1, 2)];
    expect(planDraw(lots, 2, 'line-1')).toBeNull();
    expect(planDraw(lots, 1)).toEqual([{ lotId: 'shared', quantity: 1 }]);
  });

  it('skips empty lots and reports a shortfall as null rather than a partial plan', () => {
    expect(planDraw([lot('empty', 0, 1), lot('a', 2, 2)], 3)).toBeNull();
    expect(planDraw([lot('empty', 0, 1), lot('a', 2, 2)], 2)).toEqual([
      { lotId: 'a', quantity: 2 },
    ]);
  });
});

describe('planReturn', () => {
  it('returns each unit to a lot it left, net of what already came back', () => {
    const drawn = [
      { lotId: 'a', drawn: 2, returned: 2 },
      { lotId: 'b', drawn: 3, returned: 1 },
      { lotId: 'c', drawn: 1, returned: 0 },
    ];
    expect(planReturn(drawn, 3)).toEqual([
      { lotId: 'b', quantity: 2 },
      { lotId: 'c', quantity: 1 },
    ]);
  });

  it('refuses to bring back more than went out', () => {
    expect(planReturn([{ lotId: 'a', drawn: 2, returned: 1 }], 2)).toBeNull();
  });
});

describe('planArrivalAllocation', () => {
  const waiting = (
    id: string,
    missing: number,
    confirmedOn: number | null,
  ) => ({
    orderItemId: id,
    missing,
    confirmedAt: confirmedOn === null ? null : day(confirmedOn),
  });

  it('serves the lines the goods were made for before anybody else', () => {
    const plan = planArrivalAllocation(
      3,
      [waiting('made-for', 2, 9)],
      [waiting('early', 5, 1), waiting('made-for', 2, 9)],
    );
    expect(plan).toEqual([
      { orderItemId: 'made-for', quantity: 2, complete: true },
      { orderItemId: 'early', quantity: 1, complete: false },
    ]);
  });

  it('then goes by confirmation time, undated lines last', () => {
    const plan = planArrivalAllocation(
      10,
      [],
      [
        waiting('undated', 1, null),
        waiting('late', 1, 5),
        waiting('early', 1, 2),
      ],
    );
    expect(plan.map((a) => a.orderItemId)).toEqual([
      'early',
      'late',
      'undated',
    ]);
  });

  it('leaves the surplus unallocated', () => {
    const plan = planArrivalAllocation(5, [], [waiting('a', 2, 1)]);
    expect(plan).toEqual([{ orderItemId: 'a', quantity: 2, complete: true }]);
  });

  it('allocates nothing when nothing arrived', () => {
    expect(planArrivalAllocation(0, [], [waiting('a', 2, 1)])).toEqual([]);
  });
});

describe('runningBalances', () => {
  it('walks the stock level through each ledger row', () => {
    expect(runningBalances(10, [-2, -3])).toEqual([8, 5]);
    expect(runningBalances(0, [4, 1])).toEqual([4, 5]);
  });
});

describe('averageUnitCost', () => {
  it('weights each lot by the units taken from it, net of reversals', () => {
    expect(
      averageUnitCost([
        { quantity: -1, unitCost: 100 },
        { quantity: -3, unitCost: 200 },
      ]),
    ).toBe(175);
    expect(
      averageUnitCost([
        { quantity: -2, unitCost: 100 },
        { quantity: 2, unitCost: 100 },
      ]),
    ).toBeNull();
  });
});
