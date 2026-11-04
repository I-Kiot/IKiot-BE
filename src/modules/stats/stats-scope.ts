import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import type { AuthUser } from '../../common/types/auth-user.type';
import { ErrorCode } from '../../common/errors/error-codes';

/** Phạm vi dữ liệu dashboard của người gọi. Tài khoản gắn chi nhánh/kho chỉ thấy nơi đó; không gắn gì thì thấy cả tenant. Nên thủ quỹ có `reports:read` chỉ thấy chi nhánh của mình. */

export interface LocationScope {
  branchId?: string;
  warehouseId?: string;
}

/** Đúng với hai loại tài khoản được xem toàn tenant. */
function seesWholeTenant(user: AuthUser): boolean {
  return (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  );
}

/** Phạm vi cho những gì đếm từ `Order`. Đơn chỉ bán ở chi nhánh, nên tài khoản gắn kho nhận bộ lọc không khớp và kết quả rỗng - tốt hơn nhiều so với báo doanh số cả tenant. */
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
    // Không gắn nơi nào và không phải chủ: không có gì xác định phạm vi để hiện.
    throw new ForbiddenException({
      code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
      message: 'This account has not been assigned to a branch',
    });
  }
  return requestedBranchId ? { branchId: requestedBranchId } : {};
}

/** Phạm vi cho những gì đếm từ `CashFlow` hoặc `Inventory`, có ở cả chi nhánh lẫn kho. Khi chủ chọn cả hai, kho được ưu tiên - bộ lọc cũ kiểm tra kho trước và tài liệu Swagger hứa thứ tự đó. */
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

/** Tài khoản có gắn nơi làm việc được truyền chính địa điểm của mình làm bộ lọc; chọn địa điểm người khác thì bị từ chối, không bỏ qua, vì bản cũ bỏ qua khiến quản lý tưởng đang xem chi nhánh khác khi đọc số của mình. */
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
