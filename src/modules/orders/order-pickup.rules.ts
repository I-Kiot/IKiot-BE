import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  FulfillmentType,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { ErrorCode } from '../../common/errors/error-codes';

// Quy tắc thuần của đơn khách tới lấy (STORE_PICKUP). Không đọc DB để OrderPickupService, bộ lọc danh sách và test dùng chung một nguồn.

/** Chỉ đơn khách tới lấy mới được thu tiền và giao tại quầy. */
export function assertStorePickup(order: { fulfillmentType: string }): void {
  if (order.fulfillmentType !== FulfillmentType.STORE_PICKUP) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_NOT_STORE_PICKUP,
      message: 'Only a store pickup order is handed over at the counter',
    });
  }
}

/** Đơn khách tới lấy không đi qua shipment: không có người hay hãng nào mang hàng đi. */
export function assertNotStorePickup(order: { fulfillmentType: string }): void {
  if (order.fulfillmentType === FulfillmentType.STORE_PICKUP) {
    throw new ConflictException({
      code: ErrorCode.SHIPMENT_NOT_FOR_PICKUP,
      message:
        'A store pickup order is handed over at the counter, not shipped',
    });
  }
}

/** Đơn đã đóng gói (hàng khoá khỏi kệ) và đang chờ khách mới thu tiền, giao được. */
export function assertPickupReady(order: { status: string }): void {
  if (order.status !== OrderStatus.PACKED) {
    throw new ConflictException({
      code: ErrorCode.ORDER_PICKUP_NOT_READY,
      message: `The order is ${order.status}; it must be packed and waiting for the customer`,
    });
  }
}

/** Phí giao hàng của đơn khách tới lấy luôn bằng 0. */
export function assertNoPickupShippingFee(shippingFee: number): void {
  if (shippingFee !== 0) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_PICKUP_NO_SHIPPING_FEE,
      message: 'A store pickup order has no shipping fee',
    });
  }
}

export interface PickupPaymentRow {
  kind: string;
  status: string;
  amount: number;
}

/**
 * Số khách còn phải trả để nhận hàng: tổng đơn trừ mọi khoản đã thu (cọc, thanh toán còn lại, thanh toán một lần) cộng lại khoản đã hoàn.
 * Khoản đang chờ (QR chưa về tiền) chưa tính. Không âm.
 */
export function pickupAmountDue(
  grandTotal: number,
  payments: readonly PickupPaymentRow[],
): number {
  const paid = payments.filter((p) => p.status === PaymentRecordStatus.PAID);
  const sum = (kinds: readonly string[]) =>
    paid
      .filter((p) => kinds.includes(p.kind))
      .reduce((total, p) => total + p.amount, 0);
  const received =
    sum([PaymentKind.DEPOSIT, PaymentKind.BALANCE, PaymentKind.FULL]) -
    sum([PaymentKind.REFUND]);
  return Math.max(0, Math.round(grandTotal - received));
}

/** Ngày (YYYY-MM-DD) theo lịch Việt Nam của một thời điểm. */
export function vietnamDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: VIETNAM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * Quá hạn lấy hàng: đơn còn chờ khách (PACKED) và ngày hẹn lấy đã qua theo lịch Việt Nam. Chỉ là cờ để nhân viên liên hệ khách;
 * hệ thống không tự huỷ vì huỷ còn phải quyết định hoàn hay giữ cọc (A-5).
 */
export function isPickupOverdue(
  order: {
    fulfillmentType: string;
    status: string;
    requestedDeliveryDate: Date | null;
  },
  now: Date,
): boolean {
  if (
    order.fulfillmentType !== FulfillmentType.STORE_PICKUP ||
    order.status !== OrderStatus.PACKED ||
    !order.requestedDeliveryDate
  ) {
    return false;
  }
  // Cột @db.Date đọc về là nửa đêm UTC của chính ngày đó, nên lấy phần ngày theo UTC.
  return (
    order.requestedDeliveryDate.toISOString().slice(0, 10) < vietnamDay(now)
  );
}
