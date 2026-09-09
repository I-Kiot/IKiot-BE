import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import type { AuthUser } from '../../common/types/auth-user.type';
import { ErrorCode } from '../../common/errors/error-codes';

/** Which slice of the tenant a caller's dashboard covers. The old fixed-role branch is replaced by the posting itself: an account attached to a branch or warehouse is scoped to it, one attached to neither sees the tenant. So a cashier granted `reports:read` now sees their own branch rather than every branch's revenue. */

export interface LocationScope {
  branchId?: string;
  warehouseId?: string;
}

/** True for the two account kinds that legitimately look across the whole tenant. */
function seesWholeTenant(user: AuthUser): boolean {
  return (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  );
}

/** Scope for anything counted off `Order` - sales only happen at a branch, so a warehouse posting gets an impossible filter and an empty answer, which is far better than reporting the whole tenant's sales. */
export function orderScope(
  user: AuthUser,
  requestedBranchId?: string,
): { branchId?: string; impossible?: true } {
  if (user.branchId) {
    assertOwnLocation(requestedBranchId, user.branchId, 'branch');
    return { branchId: user.branchId };
  }
  if (user.warehouseId) return { impossible: true };
  if (!seesWholeTenant(user)) {
    // Posted nowhere and not an owner: nothing identifies a slice to show.
    throw new ForbiddenException({
      code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
      message: 'This account has not been assigned to a branch',
    });
  }
  return requestedBranchId ? { branchId: requestedBranchId } : {};
}

/** Scope for anything counted off `CashFlow` or `Inventory`, which exist at branches and warehouses alike. When an owner names both, warehouse wins - the old filter checked it first and the Swagger docs promised that precedence. */
export function locationScope(
  user: AuthUser,
  requestedBranchId?: string,
  requestedWarehouseId?: string,
): LocationScope {
  if (user.branchId) {
    assertOwnLocation(requestedBranchId, user.branchId, 'branch');
    return { branchId: user.branchId };
  }
  if (user.warehouseId) {
    assertOwnLocation(requestedWarehouseId, user.warehouseId, 'warehouse');
    return { warehouseId: user.warehouseId };
  }
  if (!seesWholeTenant(user)) {
    throw new ForbiddenException({
      code: ErrorCode.ACCOUNT_HAS_NO_LOCATION,
      message: 'This account has not been assigned to a location',
    });
  }
  if (requestedWarehouseId) return { warehouseId: requestedWarehouseId };
  if (requestedBranchId) return { branchId: requestedBranchId };
  return {};
}

/** A posted account may pass its own location as the filter, but naming someone else's is refused rather than ignored - the old service ignored it, so a manager could believe they were looking at another branch while reading their own numbers. */
function assertOwnLocation(
  requested: string | undefined,
  own: string,
  label: string,
): void {
  if (requested && requested !== own) {
    throw new ForbiddenException({
      code: ErrorCode.STATS_LOCATION_DENIED,
      message: `You can only view reports for your own ${label}`,
    });
  }
}
