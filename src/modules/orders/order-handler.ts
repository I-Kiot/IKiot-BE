import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '../../common/constants/system-role';
import { ErrorCode } from '../../common/errors/error-codes';
import { can } from '../../common/utils/permission';
import type { AuthUser } from '../../common/types/auth-user.type';

// Ai được làm một bước của đơn trong hành trình bán hàng (chốt 2026-10-06). Người phụ trách là người
// làm hết các bước của đơn mình – người tạo đơn có khi chỉ "đứng page tạo đơn" – nên họ có toàn quyền
// với đúng đơn đó, ở bất kỳ kho nào. Người khác chỉ làm được bước mà role cho phép, và chỉ tại nơi mình
// được phân công. Quyền người phụ trách được suy ra lúc kiểm tra từ `order.assigneeId`, không gán vào
// role rồi thu hồi: một cặp `resource:action` không gắn được với một đơn, gán `orders:ship` cho người
// phụ trách đơn A là cho họ ship cả đơn B. Cùng cách quyền trưởng ca được tính lại mỗi request.

/** Quyền theo role của từng bước – đường thứ hai, sau chủ shop và người phụ trách. */
export const OrderStepPermission = {
  PACK: { resource: 'orders', action: 'pack' },
  HAND_OVER: { resource: 'shipments', action: 'create' },
  CHANGE_DRIVER: { resource: 'shipments', action: 'update' },
  /** Ghi nhật trình và báo giao không thành (C-3) – cùng cặp quyền với đổi shipper. */
  LOG_EVENT: { resource: 'shipments', action: 'update' },
  SHIP: { resource: 'orders', action: 'ship' },
} as const;

export type OrderStepPermission =
  (typeof OrderStepPermission)[keyof typeof OrderStepPermission];

/** Vì sao người gọi được làm bước này. `ASSIGNEE` thì nơi ghi phải nhận đơn kèm `assigneeId`, để việc đổi người phụ trách giữa chừng không lọt qua. */
export type OrderStepAccess = 'OWNER' | 'ASSIGNEE' | 'PERMISSION';

/** Trả về đường được phép, hoặc `null` nếu không được. Thuần – không đọc DB. */
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
  if (order.assigneeId !== null && order.assigneeId === user.userId) {
    return 'ASSIGNEE';
  }
  // TODO: chưa mở rộng cho trưởng ca (supervisesLocation), giống StockMovementService.canActAt.
  const postedHere = (user.branchId ?? user.warehouseId) === locationId;
  if (postedHere && can(user, permission.resource, permission.action)) {
    return 'PERMISSION';
  }
  return null;
}

/** Như `orderStepAccess` nhưng ném `ORDER_STEP_DENIED` khi không được. */
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
      message: `Only the shop owner, the order's person in charge, or someone holding ${permission.resource}:${permission.action} at this location can do this`,
    });
  }
  return access;
}

/** Điều kiện thêm vào câu nhận đơn: người được phép nhờ là người phụ trách thì phải vẫn còn là người phụ trách lúc ghi. */
export function assigneeClaim(
  access: OrderStepAccess,
  user: AuthUser,
): { assigneeId?: string } {
  return access === 'ASSIGNEE' ? { assigneeId: user.userId } : {};
}
