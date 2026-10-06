import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  assertOrderStepAccess,
  assigneeClaim,
  orderStepAccess,
  OrderStepPermission,
} from './order-handler';

const WAREHOUSE = 'warehouse-1';
const OTHER = 'warehouse-2';

/** Một tài khoản STAFF đang được phân công ở `WAREHOUSE`, với các quyền cho trước. */
function staff(permissions: string[], userId = 'staff-1'): AuthUser {
  return {
    userId,
    tenantId: 't',
    systemRole: SystemRole.STAFF,
    roleId: 'r',
    branchId: null,
    warehouseId: WAREHOUSE,
    permissions: new Set(permissions),
    shiftSupervision: null,
    email: null,
    displayName: null,
    phoneNumber: '0900000000',
  };
}

describe('orderStepAccess', () => {
  const order = { assigneeId: 'assignee-1' };

  it('lets the shop owner act anywhere', () => {
    const owner = {
      ...staff([]),
      systemRole: SystemRole.TENANT_OWNER,
      warehouseId: null,
    };
    expect(orderStepAccess(owner, order, OrderStepPermission.SHIP, OTHER)).toBe(
      'OWNER',
    );
  });

  it("lets the order's person in charge act without the permission, at any location", () => {
    const assignee = { ...staff([], 'assignee-1'), warehouseId: OTHER };
    expect(
      orderStepAccess(assignee, order, OrderStepPermission.SHIP, WAREHOUSE),
    ).toBe('ASSIGNEE');
  });

  it('lets a permission holder act at the location they are posted to', () => {
    expect(
      orderStepAccess(
        staff(['orders:ship']),
        order,
        OrderStepPermission.SHIP,
        WAREHOUSE,
      ),
    ).toBe('PERMISSION');
  });

  it('refuses a permission holder posted somewhere else', () => {
    expect(
      orderStepAccess(
        staff(['orders:ship']),
        order,
        OrderStepPermission.SHIP,
        OTHER,
      ),
    ).toBeNull();
  });

  it('refuses a permission for a different step - a packer cannot ship', () => {
    expect(
      orderStepAccess(
        staff(['orders:pack']),
        order,
        OrderStepPermission.SHIP,
        WAREHOUSE,
      ),
    ).toBeNull();
  });

  it('refuses everyone on an order nobody is in charge of, short of the owner or a permission', () => {
    expect(
      orderStepAccess(
        staff([]),
        { assigneeId: null },
        OrderStepPermission.PACK,
        WAREHOUSE,
      ),
    ).toBeNull();
  });

  it('throws ORDER_STEP_DENIED when refused', () => {
    let caught: unknown;
    try {
      assertOrderStepAccess(staff([]), order, OrderStepPermission.PACK, OTHER);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getResponse()).toMatchObject({
      code: ErrorCode.ORDER_STEP_DENIED,
    });
  });
});

describe('assigneeClaim', () => {
  it('pins the claim to the person in charge only when that is why access was granted', () => {
    const user = staff([], 'assignee-1');
    expect(assigneeClaim('ASSIGNEE', user)).toEqual({
      assigneeId: 'assignee-1',
    });
    expect(assigneeClaim('PERMISSION', user)).toEqual({});
    expect(assigneeClaim('OWNER', user)).toEqual({});
  });
});
