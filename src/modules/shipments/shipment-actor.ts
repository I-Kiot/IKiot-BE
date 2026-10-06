import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import { OrderStatus } from '../../common/constants/order-status';
import { ShipmentStatus } from '../../common/constants/shipment-status';
import { SystemRole } from '../../common/constants/system-role';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthUser } from '../../common/types/auth-user.type';
import {
  orderStepAccess,
  OrderStepPermission,
  type OrderStepAccess,
} from '../orders/order-handler';

// Ai được thao tác trên một lần giao đang trên đường, và câu "nhận" lần giao trước khi ghi. Dùng chung cho
// nhật trình / giao không thành (ShipmentService, C-3) và giao xong / thu tiền (ShipmentDeliveryService, C-5).

/** Lần giao đang trên đường (đơn đã SHIPPING): chỉ lúc này mới ghi nhật trình, báo thất bại, hay giao xong. */
export const ON_THE_ROAD_STATUSES: readonly string[] = [
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
];

/** Vì sao người gọi được thao tác: như các bước của đơn, cộng thêm "là shipper của lần giao này". */
export type ShipmentActorAccess = OrderStepAccess | 'DRIVER';

/** Phần của một lần giao mà việc kiểm tra người thao tác cần đọc. */
interface ShipmentActorFacts {
  driverId: string | null;
  fulfillment: { locationId: string };
  order: { assigneeId: string | null };
}

/**
 * Nhật trình và giao không thành (C-3): chủ shop / người phụ trách / `shipments:update` tại kho của
 * fulfillment (như các bước của đơn), hoặc shipper của chính lần giao này.
 */
export function trackingActorAccess(
  user: AuthUser,
  shipment: ShipmentActorFacts,
): ShipmentActorAccess {
  const access = orderStepAccess(
    user,
    shipment.order,
    OrderStepPermission.LOG_EVENT,
    shipment.fulfillment.locationId,
  );
  if (access) return access;
  if (shipment.driverId === user.userId) return 'DRIVER';
  throw new ForbiddenException({
    code: ErrorCode.ORDER_STEP_DENIED,
    message:
      "Only the shop owner, the order's person in charge, the shipment's driver, or someone holding shipments:update at this location can do this",
  });
}

/**
 * Giao xong và thu tiền (C-5, chốt 2026-10-06): theo hành trình, shipper của lần giao xác nhận đã giao;
 * người phụ trách đơn (toàn quyền với đơn của mình) và chủ shop cũng được. **Không** có đường "có quyền
 * trong role" – người khác không xác nhận hộ shipper được việc khách đã nhận hàng và trả tiền.
 */
export function deliveryActorAccess(
  user: AuthUser,
  shipment: ShipmentActorFacts,
): ShipmentActorAccess {
  if (
    user.systemRole === SystemRole.TENANT_OWNER ||
    user.systemRole === SystemRole.ADMIN
  ) {
    return 'OWNER';
  }
  if (
    shipment.order.assigneeId !== null &&
    shipment.order.assigneeId === user.userId
  ) {
    return 'ASSIGNEE';
  }
  if (shipment.driverId !== null && shipment.driverId === user.userId) {
    return 'DRIVER';
  }
  throw new ForbiddenException({
    code: ErrorCode.ORDER_STEP_DENIED,
    message:
      "Only the shipment's driver, the order's person in charge, or the shop owner can confirm a delivery",
  });
}

/**
 * Điều kiện ghi một lần giao đang trên đường: lần giao vẫn đang trên đường, đơn vẫn SHIPPING, và người
 * được phép nhờ là người phụ trách / shipper thì vẫn còn là người đó lúc ghi. Hai người cùng bấm (hay một
 * người bấm đúng lúc người khác đổi shipper / người phụ trách) thì câu ghi không trúng dòng nào.
 */
export function onTheRoadWhere(
  shipmentId: string,
  access: ShipmentActorAccess,
  user: AuthUser,
): Prisma.ShipmentWhereInput {
  const orderCondition: Prisma.OrderWhereInput = {
    status: OrderStatus.SHIPPING,
  };
  if (access === 'ASSIGNEE') {
    orderCondition.assigneeId = user.userId;
  }

  const where: Prisma.ShipmentWhereInput = {
    id: shipmentId,
    status: { in: [...ON_THE_ROAD_STATUSES] },
    order: orderCondition,
  };
  if (access === 'DRIVER') {
    where.driverId = user.userId;
  }
  return where;
}
