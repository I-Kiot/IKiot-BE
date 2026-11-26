import {
  normalizeWeekdays,
  previousDate,
  seriesDates,
  seriesSpanDays,
} from './schedule-series';

describe('schedule-series', () => {
  it('defaults to every day and dedupes / sorts the weekdays', () => {
    expect(normalizeWeekdays()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays([])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(normalizeWeekdays([5, 1, 5, 3])).toEqual([1, 3, 5]);
  });

  it('counts both ends of the range', () => {
    expect(seriesSpanDays('2026-12-01', '2026-12-01')).toBe(1);
    expect(seriesSpanDays('2026-12-01', '2026-12-31')).toBe(31);
    // 2028 là năm nhuận.
    expect(seriesSpanDays('2028-01-01', '2028-12-31')).toBe(366);
  });

  it('expands only the chosen weekdays, inclusive of both ends', () => {
    // 2026-12-01 là thứ Ba; Thứ 2-Thứ 6 trong tuần đầu.
    expect(seriesDates('2026-12-01', '2026-12-07', [1, 2, 3, 4, 5])).toEqual([
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-07',
    ]);
    expect(seriesDates('2026-12-01', '2026-12-31', [0])).toEqual([
      '2026-12-06',
      '2026-12-13',
      '2026-12-20',
      '2026-12-27',
    ]);
  });

  it('crosses month and year boundaries without drifting a day', () => {
    expect(
      seriesDates('2026-12-30', '2027-01-02', [0, 1, 2, 3, 4, 5, 6]),
    ).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('returns nothing when no chosen weekday falls in the range', () => {
    // 2026-12-01 (T3) - 2026-12-02 (T4): không có Chủ nhật.
    expect(seriesDates('2026-12-01', '2026-12-02', [0])).toEqual([]);
  });

  it('steps back one calendar day', () => {
    expect(previousDate('2027-01-01')).toBe('2026-12-31');
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
  });
});
