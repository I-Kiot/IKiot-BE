import { readFileSync } from 'fs';
import { join } from 'path';
import { STAFF_BASE_PERMISSIONS } from './system-role';

const SRC = join(__dirname, '..', '..');

/**
 * `STAFF_BASE_PERMISSIONS` is unioned into every employee's grants before any guard runs,
 * so a wrong key here is a permission handed to the whole shop with no checkbox to take it
 * back. These pin what the set may and may not contain, and that the two places which
 * have to honour it still do.
 */
describe('STAFF_BASE_PERMISSIONS', () => {
  it('is made of well-formed resource:action pairs', () => {
    expect(STAFF_BASE_PERMISSIONS.size).toBeGreaterThan(0);
    for (const key of STAFF_BASE_PERMISSIONS) {
      expect(key).toMatch(/^[A-Za-z_]+:[a-z_]+$/);
    }
  });

  it('never grants a widening or managerial action', () => {
    const forbidden =
      /:(update|delete|read_all|view_all|manage|approve|reject|finalize|export|assign_[a-z_]+)$/;
    for (const key of STAFF_BASE_PERMISSIONS) {
      expect(key).not.toMatch(forbidden);
    }
  });

  it.each([
    // Where the set becomes part of `AuthUser.permissions`.
    'modules/auth/strategies/jwt.strategy.ts',
    // Where it is hidden from the role editor and stripped from what a role stores.
    'modules/roles/roles.service.ts',
  ])('%s honours the set', (file) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(text).toContain('STAFF_BASE_PERMISSIONS');
  });
});
