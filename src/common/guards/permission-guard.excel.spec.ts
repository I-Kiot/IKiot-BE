import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permissions } from '../decorators/permissions.decorator';
import { SystemRole } from '../constants/system-role';
import { can } from '../utils/permission';
import { PermissionsGuard } from './permissions.guard';
import type { AuthUser } from '../types/auth-user.type';

const user = (systemRole: string, permissions: string[] = []): AuthUser =>
  ({
    userId: 'U1',
    tenantId: 't1',
    systemRole,
    permissions: new Set(permissions),
  }) as unknown as AuthUser;

// Sheet Excel "Common" - can (UTC017-UTC023).
describe('Excel sheet Common - can', () => {
  it('UTC017: platform admin is always allowed', () => {
    expect(can(user(SystemRole.ADMIN), 'orders', 'delete')).toBe(true);
  });
  it('UTC018: shop owner is always allowed', () => {
    expect(can(user(SystemRole.TENANT_OWNER), 'roles', 'update')).toBe(true);
  });
  it('UTC019: customer may read the profile', () => {
    expect(can(user(SystemRole.CUSTOMER), 'profile', 'read')).toBe(true);
  });
  it('UTC020: customer may not do anything else', () => {
    expect(can(user(SystemRole.CUSTOMER), 'orders', 'create')).toBe(false);
  });
  it('UTC021: staff holding the exact permission is allowed', () => {
    expect(
      can(user(SystemRole.STAFF, ['orders:create']), 'orders', 'create'),
    ).toBe(true);
  });
  it('UTC022: staff holding a different action of the same resource is refused', () => {
    expect(
      can(user(SystemRole.STAFF, ['orders:create']), 'orders', 'update'),
    ).toBe(false);
  });
  it('UTC023: staff with an empty permission set is refused', () => {
    expect(can(user(SystemRole.STAFF), 'products', 'read')).toBe(false);
  });
});

// Sheet Excel "Common" - PermissionsGuard.canActivate (UTC024-UTC029).
describe('Excel sheet Common - canActivate', () => {
  const guard = new PermissionsGuard(new Reflector());

  class Plain {
    handler() {
      return 1;
    }
  }
  class TwoActions {
    @Permissions('orders', 'update', 'pay_offline')
    handler() {
      return 1;
    }
  }
  @Permissions('products', 'read')
  class ClassLevel {
    @Permissions('orders', 'create')
    handler() {
      return 1;
    }
  }

  const contextOf = (
    cls: new () => { handler(): number },
    requestUser?: AuthUser,
  ) =>
    ({
      getHandler: () => cls.prototype.handler as () => number,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: requestUser }) }),
    }) as unknown as ExecutionContext;

  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return {
        type: error,
        body: (error as ForbiddenException).getResponse() as {
          code: string;
          message: string;
        },
      };
    }
    return null;
  };

  it('UTC024: a route without @Permissions needs authentication only', () => {
    expect(guard.canActivate(contextOf(Plain, user(SystemRole.STAFF)))).toBe(
      true,
    );
  });
  it('UTC025: a protected route without a user on the request is refused', () => {
    const caught = codeOf(() => guard.canActivate(contextOf(TwoActions)));
    expect(caught?.type).toBeInstanceOf(ForbiddenException);
    expect(caught?.body.code).toBe('UNAUTHENTICATED');
    expect(caught?.body.message).toBe('No authenticated user on request');
  });
  it('UTC026: holding one of the listed actions is enough', () => {
    const staff = user(SystemRole.STAFF, ['orders:pay_offline']);
    expect(guard.canActivate(contextOf(TwoActions, staff))).toBe(true);
  });
  it('UTC027: holding none of the listed actions is refused', () => {
    const caught = codeOf(() =>
      guard.canActivate(contextOf(TwoActions, user(SystemRole.STAFF))),
    );
    expect(caught?.type).toBeInstanceOf(ForbiddenException);
    expect(caught?.body.code).toBe('PERMISSION_DENIED');
    expect(caught?.body.message).toBe(
      'Missing permission orders:update or orders:pay_offline',
    );
  });
  it('UTC028: the handler requirement overrides the class requirement', () => {
    const staff = user(SystemRole.STAFF, ['orders:create']);
    expect(guard.canActivate(contextOf(ClassLevel, staff))).toBe(true);
    const onlyClass = user(SystemRole.STAFF, ['products:read']);
    expect(() => guard.canActivate(contextOf(ClassLevel, onlyClass))).toThrow(
      ForbiddenException,
    );
  });
  it('UTC029: shop owner passes any requirement', () => {
    expect(
      guard.canActivate(contextOf(TwoActions, user(SystemRole.TENANT_OWNER))),
    ).toBe(true);
  });
});
