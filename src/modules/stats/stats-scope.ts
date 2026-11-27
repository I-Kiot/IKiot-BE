import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import type { AuthUser } from '../../common/types/auth-user.type';
import { ErrorCode } from '../../common/errors/error-codes';

/** Phạm vi dữ liệu dashboard theo nơi làm việc của người gọi. */

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

/** Phạm vi cho số liệu từ đơn hàng. */
export function orderScope(
  user: AuthUser,
  requestedBranchId?: string,
): { branchId?: string } {
  if (user.branchId) {
    assertOwnLocation(requestedBranchId, user.branchId, 'branch');
    return { branchId: user.branchId };
  }
  if (user.warehouseId) {
    assertOwnLocation(requestedBranchId, user.warehouseId, 'warehouse');
    return { branchId: user.warehouseId };
  }
  if (!seesWholeTenant(user)) {
    // Không gắn nơi nào và không phải chủ: không có gì xác định phạm vi để hiện.
    throw new ForbiddenException({
      code: ErrorCode.ACCOUNT_HAS_NO_BRANCH,
      message: 'This account has not been assigned to a branch',
    });
  }
  return requestedBranchId ? { branchId: requestedBranchId } : {};
}

/** Phạm vi cho số liệu từ dòng tiền hoặc tồn kho. */
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

/** Chọn địa điểm khác nơi mình làm thì từ chối. */
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
