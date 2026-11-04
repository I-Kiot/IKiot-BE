import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import { ErrorCode } from '../../common/errors/error-codes';
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ai làm được một bước của đơn (chốt 2026-10-06). Người phụ trách làm hết các bước của đơn mình (người
// tạo đơn có khi chỉ đứng page tạo đơn) nên có toàn quyền với đúng đơn đó, ở mọi kho. Người khác chỉ làm
// được bước role cho phép, và chỉ tại nơi được phân công. Quyền người phụ trách suy ra lúc kiểm tra từ
// `order.assigneeId`, không gán vào role: gán `orders:ship` cho người phụ trách đơn A sẽ cho họ ship cả
// đơn B. Cũng như quyền trưởng ca, quyền này được tính lại mỗi request.

/**
 * Người phụ trách có được tự bấm “Bắt đầu vận chuyển” (PICKED_UP → SHIPPING) không. Bước này trừ tồn và gỡ hàng giữ, nên tạm chỉ chủ shop và người có `orders:ship` tại kho xuất (chờ khách xác nhận, 2026-10-16). Khi đồng ý thì đổi thành `true`, cùng lúc với `ASSIGNEE_MAY_SHIP` ở FE.
 */
export const ASSIGNEE_MAY_SHIP = false;

/**
 * Quyền theo role của từng bước, là đường thứ hai sau chủ shop và người phụ trách. `assigneeAllowed: false` nghĩa là người phụ trách cũng phải có quyền và đứng đúng kho như mọi người.
 */
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

/** Lý do người gọi được làm bước này. `ASSIGNEE` thì nơi ghi phải nhận đơn kèm `assigneeId`, để đổi người phụ trách giữa chừng không lọt qua. */
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

/** Mệnh đề chiếm đơn: nếu quyền đến từ người phụ trách thì lúc ghi họ vẫn phải là người phụ trách. */
export function assigneeClaim(
  access: OrderStepAccess,
  user: AuthUser,
): { assigneeId?: string } {
  return access === 'ASSIGNEE' ? { assigneeId: user.userId } : {};
}
