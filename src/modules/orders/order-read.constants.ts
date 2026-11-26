import { OrderPriority } from '../../common/constants/order-status';

// Hằng số cho phần đọc đơn.

/** Tình trạng hàng của dòng tính theo tồn trên kệ. */
export const StockCheckStatus = {
  ENOUGH: 'ENOUGH',
  PARTIAL: 'PARTIAL',
  OUT: 'OUT',
} as const;

export type StockCheckStatus =
  (typeof StockCheckStatus)[keyof typeof StockCheckStatus];

export const STOCK_CHECK_STATUSES: readonly string[] =
  Object.values(StockCheckStatus);

/** Thứ tự từ tệ nhất để tính `stockSummary`. */
export const STOCK_CHECK_SEVERITY: readonly StockCheckStatus[] = [
  StockCheckStatus.OUT,
  StockCheckStatus.PARTIAL,
  StockCheckStatus.ENOUGH,
];

/** Loại khoản thanh toán; BALANCE là khoản shipper thu khi giao. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** Các kiểu sắp xếp của `GET /orders`. */
export const ORDER_SORTS = [
  'createdAt',
  'requestedDeliveryDate',
  'priority',
] as const;

export type OrderSort = (typeof ORDER_SORTS)[number];

/** Sắp gấp nhất trước theo từng mức ưu tiên. */
export const PRIORITY_SORT_ORDER: readonly string[] = [
  OrderPriority.URGENT,
  OrderPriority.HIGH,
  OrderPriority.NORMAL,
];

/** Lý do đơn cần chú ý: thiếu hàng hoặc sắp tới ngày giao. */
export const ORDER_ATTENTION_KINDS = [
  'SHORT',
  'DUE_SOON',
  'PICKUP_OVERDUE',
] as const;

export type OrderAttentionKind = (typeof ORDER_ATTENTION_KINDS)[number];

/** Số ngày tính là sắp tới ngày giao (kể cả đã quá). */
export const DUE_SOON_DAYS = 2;
