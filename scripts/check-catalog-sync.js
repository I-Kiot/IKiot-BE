// Báo `resource:action` có trong CATALOG của prisma/seed.ts mà DB đang chạy chưa có. Deploy chỉ chạy
// `prisma migrate deploy`, không chạy seed, nên quyền thêm vào CATALOG mà không kèm migration sẽ không bao giờ
// tới DB đã triển khai: role không gán được quyền đó (khoá ngoại role_permissions -> permission_catalog) và
// route @Permissions của nó chỉ còn chủ shop vào được. `check-permissions.js` bắt lỗi ở phía code, script này
// bắt lỗi ở phía DB. Chạy sau khi deploy, hoặc trước khi mở PR thêm quyền mới:
//
//   node scripts/check-catalog-sync.js          (đọc DATABASE_URL từ .env)
//
// Thoát với mã 1 nếu thiếu dòng nào; cách sửa là thêm migration `INSERT ... ON CONFLICT DO NOTHING`
// như prisma/migrations/20261108100000_permission_catalog_missing_pairs.

require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');

// Cách đọc CATALOG giống check-permissions.js (xem ghi chú ở đó về lý do không dùng một regex cho cả khối).
const seed = fs.readFileSync(path.join(ROOT, 'prisma', 'seed.ts'), 'utf8');
const catalogSrc = seed.slice(seed.indexOf('const CATALOG'));
const wanted = new Set();
const starts = [...catalogSrc.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/gm)];
for (let i = 0; i < starts.length; i++) {
  const body = catalogSrc.slice(
    starts[i].index,
    i + 1 < starts.length ? starts[i + 1].index : catalogSrc.length,
  );
  const actionsBlock = body.match(/actions:\s*\[([\s\S]*?)\]/);
  if (!actionsBlock) continue;
  const actionsSrc = actionsBlock[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  for (const a of actionsSrc.matchAll(/'([^']+)'/g)) {
    wanted.add(`${starts[i][1]}:${a[1]}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    'SELECT resource, action FROM permission_catalog',
  );
  await client.end();

  const have = new Set(rows.map((r) => `${r.resource}:${r.action}`));
  const missing = [...wanted].filter((pair) => !have.has(pair));
  if (missing.length === 0) {
    console.log(`OK: all ${wanted.size} CATALOG pairs exist in the database.`);
    return;
  }
  console.error(
    `${missing.length} CATALOG pair(s) are missing from permission_catalog:`,
  );
  for (const pair of missing) console.error(`  ${pair}`);
  console.error(
    'Add a migration with INSERT ... ON CONFLICT DO NOTHING (see the header of this script).',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
