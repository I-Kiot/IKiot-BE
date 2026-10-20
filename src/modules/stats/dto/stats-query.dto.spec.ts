import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { StatsQueryDto } from './stats-query.dto';

const errorsOf = (query: Record<string, string>) =>
  validateSync(plainToInstance(StatsQueryDto, query)).flatMap((error) =>
    Object.values(error.constraints ?? {}),
  );

describe('StatsQueryDto range', () => {
  it('accepts "today until now" sent before 07:00 local, while UTC is still on yesterday', () => {
    // 01:03 on 2026-10-21 in Vietnam.
    expect(
      errorsOf({ fromDate: '2026-10-21', toDate: '2026-10-20T18:03:43.000Z' }),
    ).toEqual([]);
  });

  it('accepts one bare day as both bounds', () => {
    expect(errorsOf({ fromDate: '2026-10-21', toDate: '2026-10-21' })).toEqual(
      [],
    );
  });

  it('still refuses a range that runs backwards', () => {
    expect(
      errorsOf({ fromDate: '2026-10-21', toDate: '2026-10-20T16:59:59.999Z' }),
    ).toEqual(['fromDate phải trước toDate']);
    expect(errorsOf({ fromDate: '2026-10-22', toDate: '2026-10-21' })).toEqual([
      'fromDate phải trước toDate',
    ]);
  });
});
