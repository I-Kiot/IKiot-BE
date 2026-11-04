import { SystemRole } from '../constants/system-role';
import { columnsOfLocation } from '../dto/location-ref.dto';
import type { LocationEnd } from '../dto/location-ref.dto';
import type { AuthUser } from '../types/auth-user.type';
import { supervisesLocation } from '../../modules/working-schedules/shift-supervisor.service';

// "Được hành động ở đâu" - thay cho các role BRANCH_MANAGER / WAREHOUSE_MANAGER cũ, dùng chung cho
// mọi luồng làm việc tại một địa điểm (phiếu kho, yêu cầu sản xuất). Trước đây nằm riêng trong
// StockMovementService; khi luồng thứ hai cần cùng câu trả lời thì mới chuyển ra đây.

/** Địa điểm được gán cho nhân viên (`{ locationId: null }` nếu không có), hoặc `null` với tài khoản được hành động ở mọi nơi trong tenant. Branch và Warehouse dùng chung id với Location nên id được set chính là id địa điểm. */
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

/** TENANT_OWNER hành động ở mọi nơi trong tenant; STAFF ở nơi được gán hoặc nơi ca đang giám sát chạm tới. Vế giám sát chỉ quyết định *khi nào* được làm, không mở rộng *ở đâu*. Địa điểm thiếu thì không bao giờ là của nhân viên. */
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

/** Có đúng là nơi người này làm việc không. `canActAt` là về quyền và trả true ở mọi nơi với chủ shop, nên không phân biệt được đầu nào của phiếu chuyển đã tạo ra nó. */
export function isPostedAt(
  user: AuthUser,
  location: LocationEnd | null | undefined,
): boolean {
  const own = postingOf(user);
  if (!own || !location) return false;
  return own.locationId === location.id;
}
