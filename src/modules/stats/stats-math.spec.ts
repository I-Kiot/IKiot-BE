import {
  averageOrderValue,
  changePct,
  countByKey,
  parseBoundary,
  previousPeriod,
  ratioPct,
  resolveRange,
} from './stats-math';
import { DEFAULT_RANGE_DAYS, MS_PER_DAY } from './stats.constants';

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
