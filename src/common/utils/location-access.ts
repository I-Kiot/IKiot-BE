import { SystemRole } from '../constants/system-role';
import { columnsOfLocation } from '../dto/location-ref.dto';
import type { LocationEnd } from '../dto/location-ref.dto';
import type { AuthUser } from '../types/auth-user.type';
import { supervisesLocation } from '../../modules/working-schedules/shift-supervisor.service';

// Kiểm người dùng được thao tác ở địa điểm nào.

/** Địa điểm được gán cho nhân viên, null nếu được làm ở mọi nơi. */
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

/** Người dùng có được thao tác tại địa điểm này không (chủ shop mọi nơi, nhân viên nơi được gán / trực ca). */
export function canActAt(
  user: AuthUser,
  location: LocationEnd | null | undefined,
): boolean {
  const own = postingOf(user);
  if (!own) return true;
  if (!location) return false;
  // `supervisesLocation` vẫn dùng cặp branch/warehouse (giám sát ca không thuộc luồng này).
  if (supervisesLocation(user.shiftSupervision, columnsOfLocation(location))) {
    return true;
  }
  return own.locationId === location.id;
}

/** Địa điểm này có đúng là nơi người dùng làm việc không. */
export function isPostedAt(
  user: AuthUser,
  location: LocationEnd | null | undefined,
): boolean {
  const own = postingOf(user);
  if (!own || !location) return false;
  return own.locationId === location.id;
}
