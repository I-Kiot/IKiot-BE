import { LocationType } from '../../common/constants/location-type';
import type { AuthUser } from '../../common/types/auth-user.type';
import { can } from '../../common/utils/permission';

/** What a caller may read of one kind of location: every one in the tenant, or only the one they are posted to (`null` = posted to none of this kind). */
export type LocationReadScope =
  { scope: 'ALL' } | { scope: 'OWN'; ownLocationId: string | null };

// Tài nguyên phân quyền ứng với từng loại địa điểm.
const RESOURCE_OF: Record<LocationType, string> = {
  [LocationType.BRANCH]: 'branches',
  [LocationType.WAREHOUSE]: 'warehouses',
};

// Nơi tài khoản được phân công, nếu đúng loại địa điểm đang hỏi.
function postingOfType(user: AuthUser, type: LocationType): string | null {
  if (type === LocationType.BRANCH) return user.branchId;
  return user.warehouseId;
}

/**
 * Quyết định tài khoản được xem những chi nhánh / kho nào: tất cả, hay chỉ nơi mình được phân công.
 *
 * `read` (and an owner or admin, through `can`) sees the whole tenant. `read_own` - which every STAFF
 * account holds through `STAFF_BASE_PERMISSIONS` - sees only its own posting: an employee needs the
 * name and address of the place they work, but every other location's phone and address is not
 * theirs to list. The route lets either action through, so a caller reaching here with neither is
 * impossible; it is treated as `OWN` anyway, the narrow answer.
 */
export function locationReadScope(
  user: AuthUser,
  type: LocationType,
): LocationReadScope {
  if (can(user, RESOURCE_OF[type], 'read')) return { scope: 'ALL' };
  return { scope: 'OWN', ownLocationId: postingOfType(user, type) };
}
