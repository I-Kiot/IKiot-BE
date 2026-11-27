// Kiểm mọi @Permissions('resource', 'action') đều có trong CATALOG của prisma/seed.ts. Chạy: node scripts/check-permissions.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const seed = fs.readFileSync(path.join(ROOT, 'prisma', 'seed.ts'), 'utf8');
const catalogSrc = seed.slice(seed.indexOf('const CATALOG'));
const catalog = new Set();
// Tìm từng khoá resource rồi đọc tới khoá kế tiếp.
const starts = [...catalogSrc.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/gm)];
for (let i = 0; i < starts.length; i++) {
  const resource = starts[i][1];
  const body = catalogSrc.slice(
    starts[i].index,
    i + 1 < starts.length ? starts[i + 1].index : catalogSrc.length,
  );
  const actionsBlock = body.match(/actions:\s*\[([\s\S]*?)\]/);
  if (!actionsBlock) continue;
  // Bỏ qua dòng comment.
  const actionsSrc = actionsBlock[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  for (const a of actionsSrc.matchAll(/'([^']+)'/g)) {
    catalog.add(`${resource}:${a[1]}`);
  }
}

const used = new Map(); // "resource:action" -> [file]
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      // @Permissions nhận nhiều action, action nào cũng phải có trong catalog.
      for (const m of src.matchAll(/@Permissions\(\s*'([^']+)'((?:\s*,\s*'[^']+')+)\s*\)/g)) {
        const resource = m[1];
        // Mọi action trong phần đuôi đều phải có trong catalog.
        for (const a of m[2].matchAll(/'([^']+)'/g)) {
          const key = `${resource}:${a[1]}`;
          if (!used.has(key)) used.set(key, []);
          used.get(key).push(path.relative(ROOT, full));
        }
      }

      // Quét cả các lệnh `can(user, resource, action)` trong service.
      for (const m of src.matchAll(/\bcan\(\s*\w+\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) {
        const key = `${m[1]}:${m[2]}`;
        if (!used.has(key)) used.set(key, []);
        used.get(key).push(path.relative(ROOT, full));
      }

      // Quét quyền của các tool trợ lý AI, dạng `toolName: ['resource', 'action'],`.
      for (const m of src.matchAll(/^\s{2}\w+: \['([a-zA-Z_]+)', '([a-z_]+)'\],$/gm)) {
        const key = `${m[1]}:${m[2]}`;
        if (!used.has(key)) used.set(key, []);
        used.get(key).push(path.relative(ROOT, full));
      }
    }
  }
}
walk(path.join(ROOT, 'src'));

const roleSrc = fs.readFileSync(
  path.join(ROOT, 'src', 'common', 'constants', 'system-role.ts'),
  'utf8',
);
const baseBlock = roleSrc.match(
  /STAFF_BASE_PERMISSIONS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/,
);
if (!baseBlock) {
  console.error('Could not find STAFF_BASE_PERMISSIONS in system-role.ts');
  process.exit(1);
}
for (const m of baseBlock[1].matchAll(/'([^']+)'/g)) {
  if (!used.has(m[1])) used.set(m[1], []);
  used.get(m[1]).push('src/common/constants/system-role.ts (STAFF_BASE_PERMISSIONS)');
}

const missing = [...used.keys()].filter((k) => !catalog.has(k)).sort();
const unused = [...catalog].filter((k) => !used.has(k)).sort();

console.log(`Catalog pairs: ${catalog.size}`);
console.log(`@Permissions pairs in code: ${used.size}`);

if (missing.length) {
  console.error('\nMISSING from CATALOG (no role can ever be granted these):');
  for (const k of missing) console.error(`  ${k}   <- ${[...new Set(used.get(k))].join(', ')}`);
}

// Liệt kê quyền trong catalog mà không route nào dùng.
if (unused.length) {
  console.log(`\nGrantable but checked by no route (${unused.length}) - a shop can tick these and nothing changes:`);
  console.log('  ' + unused.join('\n  '));
}

if (missing.length) process.exit(1);
console.log('\nOK - every @Permissions pair exists in the catalog.');
