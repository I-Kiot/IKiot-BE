import { OrderPriority } from '../../common/constants/order-status';

// Constants only the order reads (A-9) need. They live here rather than in common/constants so
// this task does not edit the shared files; move them there if another module comes to need them.

/** An order line's `stockCheck.status` (Đủ hàng / Thiếu một phần / Hết hàng): worked out when read against on-shelf stock, never stored - it is not what was set aside for this order. An order's `stockSummary` is its worst line. */
export const StockCheckStatus = {
  ENOUGH: 'ENOUGH',
  PARTIAL: 'PARTIAL',
  OUT: 'OUT',
} as const;

export type StockCheckStatus =
  (typeof StockCheckStatus)[keyof typeof StockCheckStatus];

export const STOCK_CHECK_STATUSES: readonly string[] =
  Object.values(StockCheckStatus);

/** Worst first: an order's `stockSummary` is the first of these any of its lines has. */
export const STOCK_CHECK_SEVERITY: readonly StockCheckStatus[] = [
  StockCheckStatus.OUT,
  StockCheckStatus.PARTIAL,
  StockCheckStatus.ENOUGH,
];

/** `Payment.kind` (schema comment: FULL | DEPOSIT | BALANCE | REFUND). BALANCE is what the shipper collects on delivery - the row `collection` and `cashRemittanceStatus` are read from. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** What `GET /orders` can be sorted by. Each has one fixed direction - newest first, soonest delivery first, most urgent first - because that is the only order the screens ask for. */
export const ORDER_SORTS = [
  'createdAt',
  'requestedDeliveryDate',
  'priority',
] as const;

export type OrderSort = (typeof ORDER_SORTS)[number];

/** Most urgent first. `priority` is a plain string column, so the database would sort it alphabetically (HIGH < NORMAL < URGENT); the list walks these buckets in turn instead. */
export const PRIORITY_SORT_ORDER: readonly string[] = [
  OrderPriority.URGENT,
  OrderPriority.HIGH,
  OrderPriority.NORMAL,
];
