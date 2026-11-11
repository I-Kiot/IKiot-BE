import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ORDER_EVENT_TYPES } from './order-event-type';

const MIGRATIONS = join(__dirname, '../../../prisma/migrations');

/** Danh sách trong migration cuối cùng định nghĩa CHECK `order_events_type_check`. */
function typesInLatestCheck(): string[] {
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs.reverse()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    const match =
      /order_events_type_check"\s+CHECK\s*\(\s*"type"\s+IN\s*\(([^)]*)\)/.exec(
        sql,
      );
    if (match) return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  }
  throw new Error('no migration defines order_events_type_check');
}

describe('OrderEventType', () => {
  it('khớp CHECK order_events_type_check của migration mới nhất', () => {
    expect([...typesInLatestCheck()].sort()).toEqual(
      [...ORDER_EVENT_TYPES].sort(),
    );
  });
});
