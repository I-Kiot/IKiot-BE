import {
  averageOrderValue,
  changePct,
  comparisonWindows,
  countByKey,
  parseBoundary,
  previousPeriod,
  ratioPct,
  resolveRange,
  exceedsHourlyRange,
  stockAgingLevel,
} from './stats-math';
import {
  DEFAULT_RANGE_DAYS,
  MS_PER_DAY,
  StockAgingLevel,
} from './stats.constants';

describe('parseBoundary', () => {
  // A bare date is a local day in Vietnam, not a UTC one: 2026-03-05 starts at 17:00Z on the 4th.
  it('expands a bare YYYY-MM-DD to the local day it names', () => {
    expect(parseBoundary('2026-03-05', false).toISOString()).toBe(
      '2026-03-04T17:00:00.000Z',
    );
    expect(parseBoundary('2026-03-05', true).toISOString()).toBe(
      '2026-03-05T16:59:59.999Z',
    );
  });

  it('leaves a full timestamp with its own offset alone', () => {
    expect(parseBoundary('2026-03-05T09:30:00Z', true).toISOString()).toBe(
      '2026-03-05T09:30:00.000Z',
    );
  });
});

describe('resolveRange', () => {
  it('defaults to the 30 days ending now', () => {
    const before = Date.now();
    const { fromDate, toDate } = resolveRange();
    expect(toDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(toDate.getTime() - fromDate.getTime()).toBe(
      DEFAULT_RANGE_DAYS * MS_PER_DAY,
    );
  });

  // The bug this guards: truncating toDate to midnight would drop the named day's sales.
  it('keeps the whole of a bare toDate', () => {
    const { toDate } = resolveRange(undefined, '2026-03-05');
    expect(toDate.toISOString()).toBe('2026-03-05T16:59:59.999Z');
  });

  it('anchors a defaulted fromDate to the resolved toDate, not to now', () => {
    const { fromDate, toDate } = resolveRange(undefined, '2026-03-05');
    expect(toDate.getTime() - fromDate.getTime()).toBe(
      DEFAULT_RANGE_DAYS * MS_PER_DAY,
    );
  });
});

describe('previousPeriod', () => {
  it('is the same length and ends 1ms before the range starts', () => {
    const range = {
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-31T00:00:00.000Z'),
    };
    const previous = previousPeriod(range);

    expect(previous.toDate.getTime()).toBe(range.fromDate.getTime() - 1);
    // Both windows are inclusive at both ends, so both are span + 1 ms wide.
    expect(previous.toDate.getTime() - previous.fromDate.getTime()).toBe(
      range.toDate.getTime() - range.fromDate.getTime(),
    );
  });

  it('does not overlap the range it precedes', () => {
    const range = {
      fromDate: new Date('2026-03-01T00:00:00.000Z'),
      toDate: new Date('2026-03-08T00:00:00.000Z'),
    };
    expect(previousPeriod(range).toDate.getTime()).toBeLessThan(
      range.fromDate.getTime(),
    );
  });
});

describe('changePct', () => {
  it('rounds to one decimal place', () => {
    expect(changePct(1_234_567, 1_000_000)).toBe(23.5);
    expect(changePct(50, 200)).toBe(-75);
  });

  // Not 0 and not Infinity: "went from nothing to something" has no honest percentage, and 0 renders as "flat", the opposite of the truth.
  it('answers null when the previous period was zero', () => {
    expect(changePct(5_000_000, 0)).toBeNull();
    expect(changePct(0, 0)).toBeNull();
  });

  it('is 0 for a genuinely flat period', () => {
    expect(changePct(400, 400)).toBe(0);
  });
});

describe('averageOrderValue', () => {
  it('rounds to whole đồng', () => {
    expect(averageOrderValue(1_000_000, 3)).toBe(333_333);
  });

  it('is 0 rather than NaN when nothing was sold', () => {
    expect(averageOrderValue(0, 0)).toBe(0);
  });
});

describe('ratioPct', () => {
  it('reports a share to one decimal', () => {
    expect(ratioPct(7, 9)).toBe(77.8);
  });

  it('answers null when there is nothing to divide by', () => {
    expect(ratioPct(0, 0)).toBeNull();
  });
});

describe('countByKey', () => {
  it('folds grouped rows into a lookup', () => {
    expect(
      countByKey([
        { key: 'OPEN', count: 3 },
        { key: 'CLOSED', count: 5 },
      ]),
    ).toEqual({ OPEN: 3, CLOSED: 5 });
  });

  it('drops a null group rather than keying on "null"', () => {
    expect(countByKey([{ key: null, count: 4 }])).toEqual({});
  });
});

describe('comparisonWindows', () => {
  // Thu 2026-10-15 14:00 local = 07:00Z
  const now = new Date('2026-10-15T07:00:00Z');
  const win = (key: string) =>
    comparisonWindows(now).find((w) => w.key === key)!;
  const iso = (d: Date) => d.toISOString();

  it('compares today with the same elapsed hours of yesterday', () => {
    const w = win('today');
    expect(iso(w.current.fromDate)).toBe('2026-10-14T17:00:00.000Z');
    expect(iso(w.previous.fromDate)).toBe('2026-10-13T17:00:00.000Z');
    expect(iso(w.previous.toDate)).toBe('2026-10-14T07:00:00.000Z');
  });

  it('starts the week on Monday', () => {
    expect(iso(win('week').current.fromDate)).toBe('2026-10-11T17:00:00.000Z');
    expect(iso(win('week').previous.fromDate)).toBe('2026-10-04T17:00:00.000Z');
  });

  it('compares the month so far with the same days of last month', () => {
    const w = win('month');
    expect(iso(w.current.fromDate)).toBe('2026-09-30T17:00:00.000Z');
    expect(iso(w.previous.fromDate)).toBe('2026-08-31T17:00:00.000Z');
    expect(iso(w.previous.toDate)).toBe('2026-09-15T07:00:00.000Z');
  });

  it('rolls the quarter back across the year boundary', () => {
    const q1 = comparisonWindows(new Date('2026-02-10T05:00:00Z')).find(
      (w) => w.key === 'quarter',
    )!;
    expect(iso(q1.current.fromDate)).toBe('2025-12-31T17:00:00.000Z');
    expect(iso(q1.previous.fromDate)).toBe('2025-09-30T17:00:00.000Z');
  });

  it('never lets the previous window run into the current one', () => {
    // 31 Mar vs a February that has 28 days
    const w = comparisonWindows(new Date('2026-03-31T05:00:00Z')).find(
      (x) => x.key === 'month',
    )!;
    expect(w.previous.toDate.getTime()).toBeLessThan(
      w.current.fromDate.getTime(),
    );
  });
});

describe('stockAgingLevel', () => {
  // Biên của từng mức là chỗ dễ lệch một ngày nhất, nên kiểm từng mép.
  it.each([
    [0, StockAgingLevel.NORMAL],
    [29, StockAgingLevel.NORMAL],
    [30, StockAgingLevel.WARNING],
    [59, StockAgingLevel.WARNING],
    [60, StockAgingLevel.ATTENTION],
    [89, StockAgingLevel.ATTENTION],
    [90, StockAgingLevel.STALE],
    [400, StockAgingLevel.STALE],
  ])('%i ngày chưa bán là %s', (days, level) => {
    expect(stockAgingLevel(days)).toBe(level);
  });
});

describe('exceedsHourlyRange', () => {
  const from = new Date('2026-10-01T00:00:00.000Z');

  it('cho phép một tháng 31 ngày', () => {
    const to = new Date(from.getTime() + 31 * MS_PER_DAY);
    expect(exceedsHourlyRange({ fromDate: from, toDate: to })).toBe(false);
  });

  it('từ chối khoảng dài hơn 31 ngày', () => {
    const to = new Date(from.getTime() + 31 * MS_PER_DAY + 1);
    expect(exceedsHourlyRange({ fromDate: from, toDate: to })).toBe(true);
  });
});
