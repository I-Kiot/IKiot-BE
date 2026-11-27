/** Trạng thái đơn hoàn hàng; kiểm hàng xong là hoàn tất. */
export const OrderReturnStatus = {
  REQUESTED: 'REQUESTED',
  /** Hàng đã về shop và đang được kiểm. */
  INSPECTING: 'INSPECTING',
  COMPLETED: 'COMPLETED',
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

/** Tình trạng từng dòng hàng hoàn: GOOD vào lô bán được, DAMAGED thành lô hỏng. */
export const ReturnCondition = {
  GOOD: 'GOOD',
  DAMAGED: 'DAMAGED',
} as const;

export type ReturnCondition =
  (typeof ReturnCondition)[keyof typeof ReturnCondition];

export const RETURN_CONDITIONS: readonly string[] =
  Object.values(ReturnCondition);
