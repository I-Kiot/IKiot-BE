import { allocateProportional, sliceValue, sumDong, toDong } from './money';

describe('toDong', () => {
  it('rounds numbers, strings and Decimal-like values', () => {
    expect(toDong(10.4)).toBe(10);
    expect(toDong(10.5)).toBe(11);
    expect(toDong('1500.00')).toBe(1500);
    expect(toDong({ toNumber: () => 99.6 })).toBe(100);
  });

  it('reads null, undefined and garbage as 0', () => {
    expect(toDong(null)).toBe(0);
    expect(toDong(undefined)).toBe(0);
    expect(toDong('abc')).toBe(0);
    expect(toDong(Number.NaN)).toBe(0);
  });
});

describe('sumDong', () => {
  it('adds rounded parts so float noise cannot leak', () => {
    expect(sumDong([0.1, 0.2, 0.3])).toBe(0);
    expect(sumDong(['100000.00', { toNumber: () => 250000 }, null])).toBe(
      350000,
    );
  });
});

describe('allocateProportional', () => {
  it('splits so the parts add up exactly to the total', () => {
    const parts = allocateProportional(100, [1, 1, 1]);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('follows the weights', () => {
    expect(allocateProportional(1000, [3, 1])).toEqual([750, 250]);
  });

  it('gives zero parts when there is nothing to split', () => {
    expect(allocateProportional(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportional(100, [0, 0])).toEqual([0, 0]);
    expect(allocateProportional(100, [])).toEqual([]);
  });

  it('always sums to the total over awkward inputs', () => {
    for (const total of [1, 7, 99_999, 1_234_567]) {
      const parts = allocateProportional(total, [333_333, 1, 777_777, 12]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe('sliceValue', () => {
  it('cumulative slices add up to the line net with no drift', () => {
    const slices = [0, 1, 2].map((already) => sliceValue(100, 3, already, 1));
    expect(slices.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('returning everything at once equals the line net', () => {
    expect(sliceValue(100, 3, 0, 3)).toBe(100);
  });

  it('never goes past the line quantity', () => {
    expect(sliceValue(100, 3, 2, 5)).toBe(sliceValue(100, 3, 2, 1));
  });

  it('is 0 for an empty line', () => {
    expect(sliceValue(100, 0, 0, 1)).toBe(0);
  });
});
