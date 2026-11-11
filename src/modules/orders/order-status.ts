import { ConflictException } from '@nestjs/common';
import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

// Quy tắc chuyển trạng thái duy nhất của hành trình (contract §2, A-1). Cuộc họp 2026-10-02 bỏ thiết kế giữ hàng nên
// deriveOrderStatus / deriveLineStatus cũng bỏ theo: status đơn không còn tính từ các dòng mà do route đổi trực tiếp,
// và mọi route hành trình đều đi qua assertTransition. Quầy (PATCH /orders/:id/status) nằm ngoài hành trình nên vẫn dùng
// VALID_ORDER_TRANSITIONS trong order.constants.ts cho tới khi A-2 chuyển nó sang đây.

/**
 * Đơn hành trình đi được từ trạng thái nào sang nào. Status không có trong các khoá, kể cả status giữ hàng cũ và PENDING của quầy, thì không đi đâu được.
 *
 * - Huỷ chỉ khi hàng còn trong `stock` (tới PICKED_UP), quyết định 2026-10-05 (A-5).
 * - RETURNED chỉ đạt từ trạng thái đã trừ tồn, và chỉ khi mọi dòng đã về đủ. Trả một phần thì đơn giữ nguyên.
 */
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

/**
 * Dữ liệu ghi vào lệnh chiếm đơn COMPLETED: status và `completedAt` đi cùng nhau (CHECK `orders_completed_at_required`), nên mọi chỗ chốt đơn spread hàm này thay vì tự ghi `status: COMPLETED`.
 * `now` là một lần đọc đồng hồ của người gọi, để cùng transaction các dòng (hoá đơn, sự kiện) dùng đúng một mốc.
 */
export function completedData(now: Date): {
  status: typeof OrderStatus.COMPLETED;
  completedAt: Date;
} {
  return { status: OrderStatus.COMPLETED, completedAt: now };
}

/**
 * Bước chuyển trạng thái đơn do MỘT khoản tiền vừa vào (QR về): hàm thuần dùng chung cho đơn quầy và thu khi giao, để hai đường không lệch nhau.
 * - Đơn quầy chờ QR (PENDING) đã trả đủ → COMPLETED.
 * - Đơn giao tận nơi RECEIVED đã trả đủ và không còn tiền mặt nào shipper đang giữ → COMPLETED (còn tiền chờ nộp thì chủ xác nhận nộp mới chốt).
 * - Đơn khách tới lấy (PACKED) → không đổi: nhân viên bấm giao hàng sau (`OrderPickupService.handOver`).
 * - Trả thiếu (chưa PAID) hay trạng thái khác → không đổi.
 * Trả `null` khi không đổi.
 */
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

/**
 * Ném `ORDER_STATUS_TRANSITION_INVALID` (409) trừ khi đơn đi được từ `from` sang `to`. Hàm chỉ kiểm tra bước đi; lệnh ghi vẫn phải chiếm dòng bằng `updateMany({ where: { status: from } })`, vì hai request có thể cùng qua bước kiểm tra.
 */
export function assertTransition(from: string, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
      message: `An order cannot move from ${from} to ${to}`,
    });
  }
}
