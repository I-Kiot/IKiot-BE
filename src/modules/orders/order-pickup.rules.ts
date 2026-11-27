import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  FulfillmentType,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  OPEN_QR_PAYMENT_STATUSES,
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { VIETNAM_TIMEZONE } from '../../common/constants/timezone';
import { ErrorCode } from '../../common/errors/error-codes';
import { derivePaymentStatus } from './payment-status';
import type { MoneyLike } from '../../common/utils/money';

// Quy tắc thuần của đơn khách tới lấy.

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

/** Chỉ đổi sang/khỏi "khách tới lấy" khi chưa ai mang hàng đi. */
export function assertFulfillmentTypeChangeAllowed(
  order: { status: string; fulfillmentType: string },
  nextType: string,
  openShipments: number,
): void {
  if (nextType === order.fulfillmentType) return;
  const involvesPickup =
    nextType === FulfillmentType.STORE_PICKUP ||
    order.fulfillmentType === FulfillmentType.STORE_PICKUP;
  if (!involvesPickup) return;
  const open =
    order.status === OrderStatus.CONFIRMED ||
    (order.status === OrderStatus.PACKED && openShipments === 0);
  if (!open) {
    throw new ConflictException({
      code: ErrorCode.ORDER_FULFILLMENT_TYPE_LOCKED,
      message: `An order in ${order.status} with a shipment can no longer switch between pickup and delivery`,
    });
  }
}

/** Đơn đã thu tiền tại quầy thì không rời luồng khách tới lấy. */
export function assertNoCounterPayment(
  payments: readonly { kind: string; status: string }[],
): void {
  const collected = payments.some(
    (p) =>
      p.kind === PaymentKind.BALANCE && p.status === PaymentRecordStatus.PAID,
  );
  if (collected) {
    throw new ConflictException({
      code: ErrorCode.ORDER_PICKUP_ALREADY_COLLECTED,
      message:
        'The balance was collected at the counter; cancel the order instead of switching it to delivery',
    });
  }
}

/** Khoản QR thu tại quầy còn mở (kể cả hết hạn). */
export function openCounterQr<
  T extends { kind: string; method: string; status: string },
>(payments: readonly T[]): T[] {
  return payments.filter(
    (p) =>
      p.kind === PaymentKind.BALANCE &&
      p.method === PaymentMethod.SEPAY &&
      OPEN_QR_PAYMENT_STATUSES.includes(p.status),
  );
}

export interface PickupPaymentRow {
  kind: string;
  status: string;
  amount: MoneyLike;
}

/** Số khách còn phải trả để nhận hàng. */
export function pickupAmountDue(
  grandTotal: MoneyLike,
  payments: readonly PickupPaymentRow[],
): number {
  return derivePaymentStatus(grandTotal, payments).due;
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

/** Quá hạn lấy hàng: đơn chờ khách và đã qua ngày hẹn. */
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
