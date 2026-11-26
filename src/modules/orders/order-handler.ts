import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import { ErrorCode } from '../../common/errors/error-codes';
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';

// Quy tắc ai làm được từng bước của đơn: chủ shop, người phụ trách, hoặc người có quyền tại nơi được phân công.

/** Người phụ trách có được tự bấm "Bắt đầu vận chuyển" không; đổi cùng `ASSIGNEE_MAY_SHIP` ở FE. */
export const ASSIGNEE_MAY_SHIP = false;

/** Quyền theo role của từng bước. */
export const OrderStepPermission = {
  PACK: { resource: 'orders', action: 'pack', assigneeAllowed: true },
  HAND_OVER: { resource: 'shipments', action: 'create', assigneeAllowed: true },
  CHANGE_DRIVER: {
    resource: 'shipments',
    action: 'update',
    assigneeAllowed: true,
  },
  /** Ghi nhật trình và báo giao thất bại (C-3), dùng chung quyền với đổi shipper. */
  LOG_EVENT: { resource: 'shipments', action: 'update', assigneeAllowed: true },
  /** Xác nhận đã giao cho ĐVVC: trừ tồn kho và gỡ hàng giữ. Xem `ASSIGNEE_MAY_SHIP`. */
  SHIP: {
    resource: 'orders',
    action: 'ship',
    assigneeAllowed: ASSIGNEE_MAY_SHIP,
  },
} as const;

export type OrderStepPermission =
  (typeof OrderStepPermission)[keyof typeof OrderStepPermission];

/** Lý do người gọi được làm bước này. */
export type OrderStepAccess = 'OWNER' | 'ASSIGNEE' | 'PERMISSION';

/** Trả về đường được phép, hoặc `null` nếu không được. Thuần, không đọc DB. */
export function orderStepAccess(
  user: AuthUser,
  order: { assigneeId: string | null },
  permission: OrderStepPermission,
  locationId: string,
): OrderStepAccess | null {
  if (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  ) {
    return 'OWNER';
  }
  if (
    permission.assigneeAllowed &&
    order.assigneeId !== null &&
    order.assigneeId === user.userId
  ) {
    return 'ASSIGNEE';
  }
  // TODO: chưa mở rộng cho trưởng ca (supervisesLocation), giống StockMovementService.canActAt.
  const postedHere = (user.branchId ?? user.warehouseId) === locationId;
  if (postedHere && can(user, permission.resource, permission.action)) {
    return 'PERMISSION';
  }
  return null;
}

export function assertOrderStepAccess(
  user: AuthUser,
  order: { assigneeId: string | null },
  permission: OrderStepPermission,
  locationId: string,
): OrderStepAccess {
  const access = orderStepAccess(user, order, permission, locationId);
  if (access === null) {
    throw new ForbiddenException({
      code: ErrorCode.ORDER_STEP_DENIED,
      message: permission.assigneeAllowed
        ? `Only the shop owner, the order's person in charge, or someone holding ${permission.resource}:${permission.action} at this location can do this`
        : `Only the shop owner or someone holding ${permission.resource}:${permission.action} at this location can do this`,
    });
  }
  return access;
}

/** Ai đổi được người phụ trách: chủ shop, người đang phụ trách, hoặc có `orders:update`. */
export function reassignAccess(
  user: AuthUser,
  order: { assigneeId: string | null },
): OrderStepAccess | null {
  if (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  ) {
    return 'OWNER';
  }
  if (order.assigneeId !== null && order.assigneeId === user.userId) {
    return 'ASSIGNEE';
  }
  return can(user, 'orders', 'update') ? 'PERMISSION' : null;
}

export function assertReassignAccess(
  user: AuthUser,
  order: { assigneeId: string | null },
): OrderStepAccess {
  const access = reassignAccess(user, order);
  if (access === null) {
    throw new ForbiddenException({
      code: ErrorCode.ORDER_STEP_DENIED,
      message:
        "Only the shop owner, the order's person in charge, or someone holding orders:update can change who is in charge",
    });
  }
  return access;
}

/** Mệnh đề chiếm đơn: nếu quyền đến từ người phụ trách thì lúc ghi họ vẫn phải là người phụ trách. */
export function assigneeClaim(
  access: OrderStepAccess,
  user: AuthUser,
): { assigneeId?: string } {
  return access === 'ASSIGNEE' ? { assigneeId: user.userId } : {};
}
