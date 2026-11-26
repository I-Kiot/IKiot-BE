import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AUTO_GRANTED_PERMISSIONS,
  STAFF_BASE_PERMISSIONS,
  WORKSHOP_STAFF_PERMISSIONS,
} from './system-role';

const SRC = join(__dirname, '..', '..');

/**
 * `STAFF_BASE_PERMISSIONS` được gộp vào quyền mọi nhân viên trước khi guard chạy, nên một key sai là quyền trao cho cả shop. Test chốt những gì bộ quyền được và không được chứa.
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
    // Nơi bộ quyền trở thành một phần của `AuthUser.permissions`.
    ['modules/auth/strategies/jwt.strategy.ts', 'STAFF_BASE_PERMISSIONS'],
    ['modules/auth/strategies/jwt.strategy.ts', 'WORKSHOP_STAFF_PERMISSIONS'],
    // Nơi bộ quyền bị ẩn khỏi trình chỉnh role và bị gỡ khỏi những gì role lưu.
    ['modules/roles/roles.service.ts', 'AUTO_GRANTED_PERMISSIONS'],
  ])('%s honours %s', (file, name) => {
    const text = readFileSync(join(SRC, file), 'utf8');
    expect(text).toContain(name);
  });
});

describe('WORKSHOP_STAFF_PERMISSIONS', () => {
  it('is only production:deliver', () => {
    expect([...WORKSHOP_STAFF_PERMISSIONS]).toEqual(['production:deliver']);
  });

  it('is part of what roles can never hold, together with the staff base set', () => {
    for (const key of [
      ...STAFF_BASE_PERMISSIONS,
      ...WORKSHOP_STAFF_PERMISSIONS,
    ]) {
      expect(AUTO_GRANTED_PERMISSIONS.has(key)).toBe(true);
    }
  });
});
