import { LocationType } from '../../common/constants/location-type';
import type { AuthUser } from '../../common/types/auth-user.type';
import { can } from '../../common/utils/permission';

/** Người gọi được đọc loại địa điểm nào: mọi nơi trong tenant, hay chỉ nơi được phân công (`null` = không được phân công loại này). */
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

/**
 * Tài khoản xem được chi nhánh / kho nào: `read` (và owner / admin) xem cả tenant; `read_own` chỉ xem nơi được phân công.
 * Có cả hai quyền thì coi như `OWN` (hẹp hơn).
 */
export function locationReadScope(
  user: AuthUser,
  type: LocationType,
): LocationReadScope {
  if (can(user, RESOURCE_OF[type], 'read')) return { scope: 'ALL' };
  return { scope: 'OWN', ownLocationId: postingOfType(user, type) };
}
