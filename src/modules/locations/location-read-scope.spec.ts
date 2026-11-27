import { LocationType } from '../../common/constants/location-type';
import { SystemRole } from '../../common/constants/system-role';
import type { AuthUser } from '../../common/types/auth-user.type';
import { locationReadScope } from './location-read-scope';

const BRANCH = 'branch-1';
const WAREHOUSE = 'warehouse-1';

/** Một tài khoản STAFF với nơi phân công và các quyền cho trước. */
function staff(
  permissions: string[],
  posting: { branchId?: string; warehouseId?: string } = {},
): AuthUser {
  return {
    userId: 'staff-1',
    tenantId: 't',
    systemRole: SystemRole.STAFF,
    roleId: 'r',
    branchId: posting.branchId ?? null,
    warehouseId: posting.warehouseId ?? null,
    permissions: new Set(permissions),
    shiftSupervision: null,
    email: null,
    displayName: null,
    phoneNumber: '0900000000',
  };
}

describe('locationReadScope', () => {
  it('lets the shop owner read every location of both kinds', () => {
    const owner = { ...staff([]), systemRole: SystemRole.TENANT_OWNER };
    expect(locationReadScope(owner, LocationType.BRANCH)).toEqual({
      scope: 'ALL',
    });
    expect(locationReadScope(owner, LocationType.WAREHOUSE)).toEqual({
      scope: 'ALL',
    });
  });

  it('gives `read` the whole tenant, even with a posting', () => {
    const user = staff(['branches:read', 'branches:read_own'], {
      branchId: BRANCH,
    });
    expect(locationReadScope(user, LocationType.BRANCH)).toEqual({
      scope: 'ALL',
    });
  });

  it('narrows `read_own` to the branch the account is posted to', () => {
    const user = staff(['branches:read_own'], { branchId: BRANCH });
    expect(locationReadScope(user, LocationType.BRANCH)).toEqual({
      scope: 'OWN',
      ownLocationId: BRANCH,
    });
  });

  it('narrows `read_own` to the warehouse the account is posted to', () => {
    const user = staff(['warehouses:read_own'], { warehouseId: WAREHOUSE });
    expect(locationReadScope(user, LocationType.WAREHOUSE)).toEqual({
      scope: 'OWN',
      ownLocationId: WAREHOUSE,
    });
  });

  it('leaves a warehouse employee no branch at all', () => {
    const user = staff(['branches:read_own', 'warehouses:read_own'], {
      warehouseId: WAREHOUSE,
    });
    expect(locationReadScope(user, LocationType.BRANCH)).toEqual({
      scope: 'OWN',
      ownLocationId: null,
    });
  });

  it('leaves an account posted nowhere nothing to read', () => {
    const user = staff(['branches:read_own']);
    expect(locationReadScope(user, LocationType.BRANCH)).toEqual({
      scope: 'OWN',
      ownLocationId: null,
    });
  });

  it('does not let `warehouses:read` widen branches', () => {
    const user = staff(['warehouses:read'], { branchId: BRANCH });
    expect(locationReadScope(user, LocationType.BRANCH)).toEqual({
      scope: 'OWN',
      ownLocationId: BRANCH,
    });
    expect(locationReadScope(user, LocationType.WAREHOUSE)).toEqual({
      scope: 'ALL',
    });
  });
});
