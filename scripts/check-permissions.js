// Guards against the one failure mode the type system can't catch: a
// @Permissions('resource', 'action') in a controller that has no matching row in
// prisma/seed.ts's CATALOG. RolePermission has a real FK into PermissionCatalog, so such a
// pair can never be granted to any role - the route silently becomes reachable only by
// ADMIN/TENANT_OWNER (who short-circuit PermissionsGuard), which looks like a permissions
// bug long after the fact. Run it after touching either side.
//
//   node scripts/check-permissions.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const seed = fs.readFileSync(path.join(ROOT, 'prisma', 'seed.ts'), 'utf8');
const catalogSrc = seed.slice(seed.indexOf('const CATALOG'));
const catalog = new Set();
// Locate each `  <resource>: {` key first, then read only up to the next one. Matching a
// whole `{ ... }` block with a lazy quantifier looks equivalent but is not: the catalog
// mixes multi-line entries with single-line ones (`reports: { actions: [...] },`), and a
// single-line entry has no `\n  },` of its own to stop at, so the match runs on and
// swallows the resource that follows it. That silently dropped two resources when this
// script was first written and reported their routes as uncatalogued.
const starts = [...catalogSrc.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*\{/gm)];
for (let i = 0; i < starts.length; i++) {
  const resource = starts[i][1];
  const body = catalogSrc.slice(
    starts[i].index,
    i + 1 < starts.length ? starts[i + 1].index : catalogSrc.length,
  );
  const actionsBlock = body.match(/actions:\s*\[([\s\S]*?)\]/);
  if (!actionsBlock) continue;
  // Skip `//` comment lines so a quoted action name inside a comment isn't counted.
  const actionsSrc = actionsBlock[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  for (const a of actionsSrc.matchAll(/'([^']+)'/g)) {
    catalog.add(`${resource}:${a[1]}`);
  }
}

const used = new Map(); // "resource:action" -> [files]
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) {
      const src = fs.readFileSync(full, 'utf8');
      // Variadic since 2026-08-26: @Permissions('orders', 'update', 'pay_offline') means
      // "any of", so every action listed still has to exist in the catalog.
      for (const m of src.matchAll(/@Permissions\(\s*'([^']+)'((?:\s*,\s*'[^']+')+)\s*\)/g)) {
        const resource = m[1];
        // m[2] is the whole ", 'a', 'b'" tail - every action in it has to exist in the
        // catalog, since holding any one of them is enough to pass the guard.
        for (const a of m[2].matchAll(/'([^']+)'/g)) {
          const key = `${resource}:${a[1]}`;
          if (!used.has(key)) used.set(key, []);
          used.get(key).push(path.relative(ROOT, full));
        }
      }

      // A pair can also be checked in a *service*, through `can(user, resource, action)` -
      // `GET /orders` needs `orders:read` to be reached at all, and then widens to every
      // branch for anyone who also holds `orders:view_all`. Those calls are invisible to a
      // decorator scan, so the report used to list `orders:view_all` as "used by no route"
      // - and acting on that by deleting it from the catalog would silently narrow every
      // staff account's order visibility, because `can()` answers false for a pair nobody
      // can be granted.
      for (const m of src.matchAll(/\bcan\(\s*\w+\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) {
        const key = `${m[1]}:${m[2]}`;
        if (!used.has(key)) used.set(key, []);
        used.get(key).push(path.relative(ROOT, full));
      }

      // The AI assistant gates each of its thirty tools on a catalog pair too, but from a
      // lookup table rather than a decorator - and a typo there fails *open* in the worst
      // way imaginable: `can()` is never consulted for a resource nobody holds, so the tool
      // simply runs. Caught here instead. Shape: `toolName: ['resource', 'action'],`
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

// Not an error, but not nothing either. Every module from iKiotMS-BE is ported now, so
// "not used yet" no longer explains these: a pair here is one a shop owner can tick on the
// permission screen and which then gates nothing at all. Some are deliberate (`staff:*` is
// legacy - this codebase checks `users:*`; `cash_flows:create/update/delete` exist because
// the catalog documents the resource while the ledger stays read-only), and some are simply
// routes nobody wrote. Worth reading occasionally rather than scrolling past.
if (unused.length) {
  console.log(`\nGrantable but checked by no route (${unused.length}) - a shop can tick these and nothing changes:`);
  console.log('  ' + unused.join('\n  '));
}

if (missing.length) process.exit(1);
console.log('\nOK - every @Permissions pair exists in the catalog.');
