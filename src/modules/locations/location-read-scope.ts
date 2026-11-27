import { LocationType } from '../../common/constants/location-type';
import type { AuthUser } from '../../common/types/auth-user.type';
import { can } from '../../common/utils/permission';

/** Phạm vi đọc địa điểm của người gọi. */
export type LocationReadScope =
  { scope: 'ALL' } | { scope: 'OWN'; ownLocationId: string | null };

const RESOURCE_OF: Record<LocationType, string> = {
  [LocationType.BRANCH]: 'branches',
  [LocationType.WAREHOUSE]: 'warehouses',
};

function postingOfType(user: AuthUser, type: LocationType): string | null {
  if (type === LocationType.BRANCH) return user.branchId;
  return user.warehouseId;
}

/** Chi nhánh / kho người gọi được xem. */
export function locationReadScope(
  user: AuthUser,
  type: LocationType,
): LocationReadScope {
  if (can(user, RESOURCE_OF[type], 'read')) return { scope: 'ALL' };
  return { scope: 'OWN', ownLocationId: postingOfType(user, type) };
}
