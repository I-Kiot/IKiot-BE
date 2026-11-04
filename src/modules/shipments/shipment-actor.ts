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

// Kiểm người thao tác trên lần giao đang trên đường, dùng chung cho nhật trình / giao không thành (ShipmentService, C-3)
// và giao xong / thu tiền (ShipmentDeliveryService, C-5).

/** Lần giao đang trên đường (đơn đã SHIPPING): chỉ lúc này mới ghi nhật trình, báo thất bại, hay giao xong. */
export const ON_THE_ROAD_STATUSES: readonly string[] = [
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  // Lần giao thất bại vẫn đang trên đường (hàng chưa về shop): shipper còn ghi nhật trình mới hoặc giao lại.
  // Chỉ khi shop xác nhận hàng đã hoàn về thì mới kết thúc.
  ShipmentStatus.FAILED,
];

export type ShipmentActorAccess = OrderStepAccess | 'DRIVER';

interface ShipmentActorFacts {
  driverId: string | null;
  fulfillment: { locationId: string };
  order: { assigneeId: string | null };
}

/** Ai được ghi nhật trình / báo thất bại (C-3): như các bước của đơn, hoặc shipper của chính lần giao. */
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
 * Ai được xác nhận lấy hàng / giao xong / thu tiền (C-5): shipper của lần giao, người phụ trách đơn, chủ shop. Không có đường “có quyền trong role”: người khác không xác nhận hộ việc khách đã nhận hàng và trả tiền.
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
      "Only the shipment's driver, the order's person in charge, or the shop owner can confirm a pickup or a delivery",
  });
}

/**
 * Điều kiện ghi khi lần giao đang trên đường: lần giao vẫn đang đi, đơn vẫn SHIPPING, và người được nhờ vẫn là người phụ trách / shipper lúc ghi. Hai người cùng bấm (hoặc đổi shipper đúng lúc bấm) thì câu ghi không khớp dòng nào.
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
