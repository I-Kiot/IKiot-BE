/**
 * The order journey (docs/order-flow.md, "Trạng thái"). The order status and each line's status
 * are kept apart on purpose: one combo can hold a piece already on the shelf and a piece still
 * at the workshop, so the order's status is derived from its lines, never set beside them.
 */
export const OrderStatus = {
  /** A manual order still being quoted - nothing reserved. */
  DRAFT: 'DRAFT',
  /** A marketplace order just synced; its stock is already held. */
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  /** Confirmed, at least one line still waiting for stock. */
  CONFIRMED: 'CONFIRMED',
  /** Every line is READY. */
  READY_TO_PACK: 'READY_TO_PACK',
  /** The fulfillment is verified - stock has been deducted. */
  PACKED: 'PACKED',
  /** Handed over to whoever delivers it. Stock does not change here. */
  SHIPPING: 'SHIPPING',
  DELIVERED: 'DELIVERED',
  /** Delivered and paid in full. */
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  /** Every line has come back. */
  RETURNED: 'RETURNED',
  /**
   * Legacy: the till's "awaiting the SePay transfer" state from before the order journey. The
   * current `OrdersService` still opens a SePay sale here; track A (A-2) moves the till onto
   * the statuses above and migrates these rows, after which this entry goes.
   */
  PENDING: 'PENDING',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUSES: readonly string[] = Object.values(OrderStatus);

/** Statuses that need no person in charge yet - every other one is pinned by the `orders_assignee_required` CHECK. */
export const UNASSIGNED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.DRAFT,
  OrderStatus.PENDING_CONFIRMATION,
];

/** Statuses in which the order still holds stock (ACTIVE reservations) and may still be cancelled by releasing it. */
export const RESERVING_ORDER_STATUSES: readonly string[] = [
  OrderStatus.PENDING_CONFIRMATION,
  OrderStatus.CONFIRMED,
  OrderStatus.READY_TO_PACK,
];

/** Nothing moves an order out of these. */
export const FINAL_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** One order line's own progress. */
export const OrderItemStatus = {
  PENDING: 'PENDING',
  /** Some or all of the quantity is not held yet (short, or a custom piece being made). */
  WAITING_STOCK: 'WAITING_STOCK',
  /** The whole quantity is held. */
  READY: 'READY',
  PACKED: 'PACKED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
} as const;

export type OrderItemStatus =
  (typeof OrderItemStatus)[keyof typeof OrderItemStatus];

export const ORDER_ITEM_STATUSES: readonly string[] =
  Object.values(OrderItemStatus);

/** What kind of line it is. A COMBO line carries the price and no stock; its COMBO_COMPONENT children carry the stock at price 0. */
export const OrderLineType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  COMBO_COMPONENT: 'COMBO_COMPONENT',
  SERVICE: 'SERVICE',
} as const;

export type OrderLineType = (typeof OrderLineType)[keyof typeof OrderLineType];

export const ORDER_LINE_TYPES: readonly string[] = Object.values(OrderLineType);

/** Lines that hold stock. COMBO is priced only and SERVICE needs no goods, so neither is ever reserved, packed or deducted. */
export const STOCKED_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO_COMPONENT,
];

/** Where the order came from. MANUAL covers both an order typed in by staff and a sale at the counter - they are one channel; the counter only differs by `fulfillmentType = TAKEAWAY`. There is no web channel. */
export const OrderChannel = {
  MANUAL: 'MANUAL',
  SHOPEE: 'SHOPEE',
} as const;

export type OrderChannel = (typeof OrderChannel)[keyof typeof OrderChannel];

export const ORDER_CHANNELS: readonly string[] = Object.values(OrderChannel);

/** How the goods reach the customer. TAKEAWAY still goes through a verified fulfillment - that is where its stock is deducted. */
export const FulfillmentType = {
  TAKEAWAY: 'TAKEAWAY',
  STORE_PICKUP: 'STORE_PICKUP',
  HOME_DELIVERY: 'HOME_DELIVERY',
} as const;

export type FulfillmentType =
  (typeof FulfillmentType)[keyof typeof FulfillmentType];

export const FULFILLMENT_TYPES: readonly string[] =
  Object.values(FulfillmentType);

/** Derived from the order's Payment rows (Phase 2, E-5) - never set from a request. */
export const OrderPaymentStatus = {
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
} as const;

export type OrderPaymentStatus =
  (typeof OrderPaymentStatus)[keyof typeof OrderPaymentStatus];

export const ORDER_PAYMENT_STATUSES: readonly string[] =
  Object.values(OrderPaymentStatus);
