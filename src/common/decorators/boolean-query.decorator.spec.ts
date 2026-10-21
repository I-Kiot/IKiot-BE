import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BooleanQuery } from './boolean-query.decorator';

class Query {
  @BooleanQuery()
  flag?: boolean;
}

const parse = (raw: Record<string, unknown>) => {
  const query = plainToInstance(Query, raw);
  return { query, errors: validateSync(query) };
};

describe('BooleanQuery', () => {
  it('reads the two words a query string can carry', () => {
    expect(parse({ flag: 'true' }).query.flag).toBe(true);
    expect(parse({ flag: 'false' }).query.flag).toBe(false);
  });

  it('keeps a real boolean and leaves an absent flag undefined', () => {
    expect(parse({ flag: true }).query.flag).toBe(true);
    const absent = parse({});
    expect(absent.query.flag).toBeUndefined();
    expect(absent.errors).toHaveLength(0);
  });

  it('refuses anything else instead of reading it as false', () => {
    for (const value of ['yes', '1', '', 'TRUE']) {
      expect(parse({ flag: value }).errors).toHaveLength(1);
    }
  });
});
