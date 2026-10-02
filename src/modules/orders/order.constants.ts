import { OrderStatus } from '../../common/constants/order-status';

// The status vocabulary is shared with the fulfillment, shipment and return modules, so it lives in common/constants; the transitions below are still the till's four-state flow until A-2/A-3 replace them.
export {
  OrderStatus,
  ORDER_STATUSES,
} from '../../common/constants/order-status';

/** Where an order may go from where it is. A completed sale is never un-completed, only RETURNED; CANCELLED and RETURNED are both terminal, so correcting either means a new order. */
export const VALID_ORDER_TRANSITIONS: Readonly<
  Record<string, readonly string[]>
> = {
  [OrderStatus.PENDING]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

/** What a client may ask for on PATCH /orders/:id/status. */
export const SETTABLE_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** Payment methods where the money is in hand as the order is rung up, so it opens COMPLETED. SEPAY is the exception: the bank tells us afterwards, so it opens PENDING and waits for the webhook. */
export const INSTANT_COMPLETE_METHODS: readonly string[] = [
  'CASH',
  'BANK_TRANSFER',
  'MOMO',
  'VNPAY',
];

/** What `POST /orders/:id/pay-offline` may settle a stuck SePay order with. */
export const OFFLINE_PAYMENT_METHODS: readonly string[] = [
  ...INSTANT_COMPLETE_METHODS,
];
