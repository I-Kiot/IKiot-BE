/** An OrderReturn ("đơn hoàn hàng"), created by hand for any channel. INSPECTED is where the goods are put away and the stock moves. */
export const OrderReturnStatus = {
  PENDING: 'PENDING',
  INSPECTED: 'INSPECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type OrderReturnStatus =
  (typeof OrderReturnStatus)[keyof typeof OrderReturnStatus];

export const ORDER_RETURN_STATUSES: readonly string[] =
  Object.values(OrderReturnStatus);

export const OrderReturnReason = {
  CUSTOMER_RETURN: 'CUSTOMER_RETURN',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
} as const;

export type OrderReturnReason =
  (typeof OrderReturnReason)[keyof typeof OrderReturnReason];

export const ORDER_RETURN_REASONS: readonly string[] =
  Object.values(OrderReturnReason);

/** Set per line at inspection. GOOD goes back to a sellable location; DAMAGED goes to that location's damaged-goods location (`Location.damagedLocationId`, `isSellable = false`). */
export const ReturnCondition = {
  GOOD: 'GOOD',
  DAMAGED: 'DAMAGED',
} as const;

export type ReturnCondition =
  (typeof ReturnCondition)[keyof typeof ReturnCondition];

export const RETURN_CONDITIONS: readonly string[] =
  Object.values(ReturnCondition);
