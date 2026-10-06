/**
 * The order journey (docs/hanh-trinh-don-hang.md, revised after the 2026-10-02 meeting):
 * PENDING_CONFIRMATION (Shopee) → CONFIRMED → PACKED → PICKED_UP → SHIPPING → RECEIVED → COMPLETED.
 * Confirming holds nothing. Packing locks the goods off the shelf (inventories.locked_stock, since
 * 2026-10-04) and is refused when the shelf is short; they are deducted once, on the move to
 * SHIPPING, together with their lock. Every status change
 * goes through one transition function (contract §2, A-1).
 *
 * The entries marked @deprecated belong to the reservation design the meeting dropped. They stay
 * only so the fulfillment / allocation code written against it still compiles until tracks A and
 * C rewrite it (contract §7); migration 20261004120000 refuses to run while an order sits in one.
 */
export const OrderStatus = {
  /** A marketplace order just synced, waiting for staff to confirm it and name a person in charge. */
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  /** Confirmed with a person in charge - where a manual order is born. Stock is not touched. */
  CONFIRMED: 'CONFIRMED',
  /** Packed, waiting for the shipper / carrier. Its goods are locked off the shelf (`lockStock`), still in `stock`. */
  PACKED: 'PACKED',
  /** The shipper / carrier has the goods. Still locked, still in `stock`. */
  PICKED_UP: 'PICKED_UP',
  /** Confirmed under way by someone holding orders:ship - the locked goods leave `stock` here (`shipLockedStock`). */
  SHIPPING: 'SHIPPING',
  /** Delivered and paid in cash to the shipper; waiting for the owner to confirm the cash came back in full. */
  RECEIVED: 'RECEIVED',
  /** Delivered and paid in full - and, for cash, handed back. */
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
  /** @deprecated reservation design - nothing creates it (contract §7). */
  DRAFT: 'DRAFT',
  /** @deprecated reservation design - nothing creates it (contract §7). */
  READY_TO_PACK: 'READY_TO_PACK',
  /** @deprecated replaced by RECEIVED (contract §7). */
  DELIVERED: 'DELIVERED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUSES: readonly string[] = Object.values(OrderStatus);

/** Statuses that need no person in charge yet - every other one is pinned by the `orders_assignee_required` CHECK. */
export const UNASSIGNED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.PENDING_CONFIRMATION,
];

/** Orders still waiting to leave: their lines are the demand the production list and stockCheck count, and they can still be edited. */
export const UNSHIPPED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PACKED,
  OrderStatus.PICKED_UP,
];

/** Nothing moves an order out of these. */
export const FINAL_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** One order line's own progress. Whether its stock is there is shown (stockCheck), not stored. */
export const OrderItemStatus = {
  PENDING: 'PENDING',
  /** Its stock was deducted when the order moved to SHIPPING. */
  SHIPPED: 'SHIPPED',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
  /** @deprecated reservation design (contract §7). */
  WAITING_STOCK: 'WAITING_STOCK',
  /** @deprecated reservation design (contract §7). */
  READY: 'READY',
  /** @deprecated reservation design (contract §7) - migrated to SHIPPED. */
  PACKED: 'PACKED',
  /** @deprecated migrated to SHIPPED. */
  DELIVERED: 'DELIVERED',
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

/** Lines that hold stock. COMBO is priced only and SERVICE needs no goods, so neither is ever deducted. */
export const STOCKED_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO_COMPONENT,
];

/** Where the order came from. MANUAL and SHOPEE are both orders the customer placed online (docs/hanh-trinh-don-hang.md); MANUAL is one staff typed in. A POS sale at the counter is stored as MANUAL too, outside the journey; the counter only differs by `fulfillmentType = TAKEAWAY`. There is no channel for an own website. */
export const OrderChannel = {
  MANUAL: 'MANUAL',
  SHOPEE: 'SHOPEE',
} as const;

export type OrderChannel = (typeof OrderChannel)[keyof typeof OrderChannel];

export const ORDER_CHANNELS: readonly string[] = Object.values(OrderChannel);

/** How the goods reach the customer. TAKEAWAY is a POS sale at the counter: paid and deducted at once, outside the order journey. */
export const FulfillmentType = {
  TAKEAWAY: 'TAKEAWAY',
  STORE_PICKUP: 'STORE_PICKUP',
  HOME_DELIVERY: 'HOME_DELIVERY',
} as const;

export type FulfillmentType =
  (typeof FulfillmentType)[keyof typeof FulfillmentType];

export const FULFILLMENT_TYPES: readonly string[] =
  Object.values(FulfillmentType);

/** The tag staff pick the next order to ship by (with requestedDeliveryDate). A fixed list, highest last, so it sorts. */
export const OrderPriority = {
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;

export type OrderPriority = (typeof OrderPriority)[keyof typeof OrderPriority];

export const ORDER_PRIORITIES: readonly string[] = Object.values(OrderPriority);

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

/** `Payment.remittanceStatus`: has the cash a shipper collected reached the owner? PENDING only on a CASH balance collected on delivery. */
export const RemittanceStatus = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
} as const;

export type RemittanceStatus =
  (typeof RemittanceStatus)[keyof typeof RemittanceStatus];

export const REMITTANCE_STATUSES: readonly string[] =
  Object.values(RemittanceStatus);
