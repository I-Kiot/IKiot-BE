import { OrderStatus } from '../../common/constants/order-status';

// Từ vựng status dùng chung với fulfillment, shipment và return nên nằm trong common/constants; các chuyển trạng thái bên dưới vẫn là luồng 4 trạng thái của quầy cho tới khi A-2/A-3 thay thế.
export {
  OrderStatus,
  ORDER_STATUSES,
} from '../../common/constants/order-status';

/** Đơn đi được từ trạng thái nào. Đơn đã COMPLETED không quay lại, chỉ có thể RETURNED; CANCELLED và RETURNED đều là trạng thái cuối, muốn sửa thì tạo đơn mới. */
export const VALID_ORDER_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = {
  [OrderStatus.PENDING]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

export const SETTABLE_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** Phương thức thu tiền ngay khi lên đơn, nên đơn mở ở COMPLETED. SEPAY là ngoại lệ: ngân hàng báo sau nên đơn mở ở PENDING và chờ webhook. */
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
