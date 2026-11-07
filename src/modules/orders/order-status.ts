import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../../common/constants/order-status';
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
