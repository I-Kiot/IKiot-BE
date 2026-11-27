import { OrderStatus } from '../../common/constants/order-status';

// Luồng trạng thái của đơn quầy.
export {
  OrderStatus,
  ORDER_STATUSES,
} from '../../common/constants/order-status';

/** Các bước chuyển trạng thái hợp lệ của đơn quầy. */
export const VALID_ORDER_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = {
  // Đơn quầy chờ SePay chỉ huỷ được bằng PATCH status.
  [OrderStatus.PENDING]: [OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

export const SETTABLE_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** Phương thức thu tiền ngay, đơn mở ở COMPLETED; SEPAY mở ở PENDING chờ webhook. */
export const INSTANT_COMPLETE_METHODS: readonly string[] = [
  'CASH',
  'BANK_TRANSFER',
  'MOMO',
  'VNPAY',
];

/** Phương thức được dùng để chốt đơn SePay đang treo qua `POST /orders/:id/pay-offline`. */
export const OFFLINE_PAYMENT_METHODS: readonly string[] = [
  ...INSTANT_COMPLETE_METHODS,
];
