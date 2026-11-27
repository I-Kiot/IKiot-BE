import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../constants/system-role';
import { narrowStaffScope, narrowToScope } from './scope-filter';
import { requireTenantId, resolveTenantScope } from './tenant-scope';
import type { AuthUser } from '../types/auth-user.type';

const user = (over: Partial<AuthUser>): AuthUser =>
  ({
    userId: 'U1',
    tenantId: 't1',
    systemRole: SystemRole.STAFF,
    permissions: new Set(),
    ...over,
  }) as AuthUser;

const admin = user({ systemRole: SystemRole.ADMIN, tenantId: null });
const owner = user({ systemRole: SystemRole.TENANT_OWNER });

/** Chạy `fn` và kiểm tra nó ném lỗi `type` với `code` (và `message` nếu có). */
function expectThrows(
  fn: () => unknown,
  type: new (...args: never[]) => Error,
  code: string,
  message?: string,
) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  const body = (caught as ForbiddenException).getResponse() as {
    code: string;
    message: string;
  };
  expect(body.code).toBe(code);
  if (message) expect(body.message).toBe(message);
}

// Sheet Excel "Common" - resolveTenantScope (UTC001-UTC006).
describe('Excel sheet Common - resolveTenantScope', () => {
  it('UTC001: platform admin without a requested tenant sees every tenant', () => {
    expect(resolveTenantScope(admin, undefined)).toBeUndefined();
  });
  it('UTC002: platform admin may name any tenant', () => {
    expect(resolveTenantScope(admin, 't2')).toBe('t2');
  });
  it('UTC003: shop user without a requested tenant gets their own', () => {
    expect(resolveTenantScope(owner, undefined)).toBe('t1');
  });
  it('UTC004: shop user naming their own tenant is accepted', () => {
    expect(resolveTenantScope(owner, 't1')).toBe('t1');
  });
  it('UTC005: shop user naming another tenant is refused', () => {
    expectThrows(
      () => resolveTenantScope(owner, 't2'),
      ForbiddenException,
      'TENANT_MISMATCH',
      'Cannot access another tenant',
    );
  });
  it('UTC006: non-admin without a tenant is refused', () => {
    expectThrows(
      () => resolveTenantScope(user({ tenantId: null }), undefined),
      ForbiddenException,
      'ACCOUNT_HAS_NO_TENANT',
      'Account is not attached to a tenant',
    );
  });
});

// Sheet Excel "Common" - requireTenantId (UTC007-UTC009).
describe('Excel sheet Common - requireTenantId', () => {
  it('UTC007: platform admin must name a tenant for a write', () => {
    expectThrows(
      () => requireTenantId(admin, undefined),
      BadRequestException,
      'TENANT_ID_REQUIRED',
      'ADMIN accounts belong to no tenant - this action must name one explicitly',
    );
  });
  it('UTC008: platform admin naming a tenant gets it back', () => {
    expect(requireTenantId(admin, 't2')).toBe('t2');
  });
  it('UTC009: shop user gets their own tenant', () => {
    expect(requireTenantId(owner, undefined)).toBe('t1');
  });
});

// Sheet Excel "Common" - narrowToScope (UTC010-UTC013).
describe('Excel sheet Common - narrowToScope', () => {
  it('UTC010: no requested filter keeps the server scope', () => {
    expect(narrowToScope('b1', undefined, 'denied')).toBe('b1');
  });
  it('UTC011: requested filter equal to the scope is accepted', () => {
    expect(narrowToScope('b1', 'b1', 'denied')).toBe('b1');
  });
  it('UTC012: requested filter different from the scope is refused', () => {
    expectThrows(
      () => narrowToScope('b1', 'b2', 'denied'),
      ForbiddenException,
      'SCOPE_FILTER_DENIED',
      'denied',
    );
  });
  it('UTC013: without a server scope the requested filter is used', () => {
    expect(narrowToScope(undefined, 'b2', 'denied')).toBe('b2');
  });
});

// Sheet Excel "Common" - narrowStaffScope (UTC014-UTC016).
describe('Excel sheet Common - narrowStaffScope', () => {
  const messages = { own: 'own-denied', location: 'location-denied' };
  it('UTC014: a query that repeats the scope is accepted', () => {
    expect(
      narrowStaffScope(
        { userId: 'u1', branchId: 'b1' },
        { userId: 'u1', branchId: 'b1' },
        messages,
      ),
    ).toEqual({ userId: 'u1', branchId: 'b1', warehouseId: undefined });
  });
  it("UTC015: another user's id is refused with the 'own' message", () => {
    expectThrows(
      () => narrowStaffScope({ userId: 'u1' }, { userId: 'u2' }, messages),
      ForbiddenException,
      'SCOPE_FILTER_DENIED',
      'own-denied',
    );
  });
  it("UTC016: another branch is refused with the 'location' message", () => {
    expectThrows(
      () => narrowStaffScope({ branchId: 'b1' }, { branchId: 'b2' }, messages),
      ForbiddenException,
      'SCOPE_FILTER_DENIED',
      'location-denied',
    );
  });
});
