import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Mọi chỗ chốt đơn COMPLETED phải ghi bút toán SALE. */
describe('sales journal wiring', () => {
  const root = join(__dirname, '..', '..');
  const files = sourceFiles(root).filter(
    (f) =>
      !f.endsWith(join('orders', 'sales-journal.ts')) &&
      !f.endsWith(join('orders', 'order-status.ts')),
  );

  it('every file that completes an order also posts the SALE', () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      const completes =
        /completedData\(/.test(text) || /\? \{ completedAt: now \}/.test(text);
      return completes && !/postSale\(/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('no service writes the journal except sales-journal.ts', () => {
    const offenders = files.filter((f) =>
      /salesJournal(Entry|Line)\.(create|createMany|update|updateMany|upsert)/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => f.replace(root, ''))).toEqual([]);
  });
});
