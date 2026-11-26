import { ConflictException } from '@nestjs/common';
import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

// Quy tắc chuyển trạng thái của hành trình đơn; mọi route hành trình đi qua `assertTransition`.

/** Các bước chuyển trạng thái hợp lệ của đơn hành trình. */
export const ORDER_JOURNEY_TRANSITIONS: Readonly<
  Partial<Record<string, readonly OrderStatus[]>>
> = {
  [OrderStatus.PENDING_CONFIRMATION]: [
    OrderStatus.CONFIRMED,
    OrderStatus.CANCELLED, // Shopee hủy đơn (E-3)
  ],
  [OrderStatus.CONFIRMED]: [
    OrderStatus.PACKED, // C-1 đóng gói: hàng bị khóa
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PACKED]: [
    OrderStatus.PICKED_UP, // C-2 tạo shipment (POST /shipments)
    OrderStatus.COMPLETED, // khách tới lấy: giao tại quầy, bỏ qua shipment (chỉ STORE_PICKUP, OrderPickupService chặn)
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PICKED_UP]: [
    OrderStatus.SHIPPING, // C-2 giao: hàng khóa rời kho
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.SHIPPING]: [
    OrderStatus.RECEIVED, // giao xong, đã thu tiền (A-10)
    OrderStatus.COMPLETED, // giao xong, thu QR hoặc không còn gì để thu (A-10)
    OrderStatus.RETURNED, // giao thất bại, hàng đã về đủ
  ],
  [OrderStatus.RECEIVED]: [
    OrderStatus.COMPLETED, // xác nhận nộp tiền (A-10)
    OrderStatus.RETURNED,
  ],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

/** Dữ liệu chốt đơn COMPLETED: status và `completedAt` đi cùng nhau. */
export function completedData(now: Date): {
  status: typeof OrderStatus.COMPLETED;
  completedAt: Date;
} {
  return { status: OrderStatus.COMPLETED, completedAt: now };
}

/** Trạng thái tiếp theo khi một khoản tiền vừa vào, null nếu không đổi. */
export function nextStatusAfterPayment(
  order: { status: string; fulfillmentType: string },
  derived: { status: string },
  pendingRemittance: boolean,
): OrderStatus | null {
  if (derived.status !== OrderPaymentStatus.PAID) return null;
  if (
    order.fulfillmentType === FulfillmentType.TAKEAWAY &&
    order.status === OrderStatus.PENDING
  ) {
    return OrderStatus.COMPLETED;
  }
  if (
    order.fulfillmentType === FulfillmentType.HOME_DELIVERY &&
    order.status === OrderStatus.RECEIVED &&
    !pendingRemittance
  ) {
    return OrderStatus.COMPLETED;
  }
  return null;
}

export function canTransition(from: string, to: OrderStatus): boolean {
  return ORDER_JOURNEY_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Ném `ORDER_STATUS_TRANSITION_INVALID` nếu không đi được từ `from` sang `to`. */
export function assertTransition(from: string, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
      message: `An order cannot move from ${from} to ${to}`,
    });
  }
}
