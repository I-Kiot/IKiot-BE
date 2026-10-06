import { SystemRole } from '../constants/system-role';
import { columnsOfLocation } from '../dto/location-ref.dto';
import type { LocationEnd } from '../dto/location-ref.dto';
import type { AuthUser } from '../types/auth-user.type';
import { supervisesLocation } from '../../modules/working-schedules/shift-supervisor.service';

// "Where may this account act" - the substitution for the old BRANCH_MANAGER / WAREHOUSE_MANAGER
// roles, shared by every flow that works at one location (stock movements, production requests).
// It used to live privately in StockMovementService; a second flow needing the same answer is
// what moved it here (coding rule 6).

/** Where a staff account is posted - `{ locationId: null }` if nowhere - or `null` for an account that may act anywhere in the tenant. `AuthUser` still carries the branch/warehouse pair, but a Branch or Warehouse shares its id with its Location, so whichever is set *is* the Location id. */
export function postingOf(
  user: AuthUser,
): { locationId: string | null } | null {
  if (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  ) {
    return null;
  }
  return { locationId: user.branchId ?? user.warehouseId };
}

/** A TENANT_OWNER acts anywhere in the tenant, a STAFF account where it is posted - or where the shift it is currently supervising reaches. That clause only ever widens to a location the supervisor is already posted at, so it is about when they may act, not where. A missing location is never a staff account's. */
export function canActAt(
  user: AuthUser,
  location: LocationEnd | null | undefined,
): boolean {
  const own = postingOf(user);
  if (!own) return true;
  if (!location) return false;
  // `supervisesLocation` still speaks the branch/warehouse pair (shift supervision is not this flow's).
  if (supervisesLocation(user.shiftSupervision, columnsOfLocation(location))) {
    return true;
  }
  return own.locationId === location.id;
}

/** Whether this is literally where the actor works. `canActAt` is about permission and answers true everywhere for an owner, which cannot tell which end of a transfer raised it. */
export function isPostedAt(
  user: AuthUser,
  location: LocationEnd | null | undefined,
): boolean {
  const own = postingOf(user);
  if (!own || !location) return false;
  return own.locationId === location.id;
}
