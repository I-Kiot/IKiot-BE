/** Đơn hoàn hàng (OrderReturn), tạo tay cho mọi kênh. Hàng đổi kho khi được kiểm tra, và kiểm tra cũng hoàn tất đơn. Nhập lại hay ghi nhận hỏng là theo từng dòng (`condition`), không phải trạng thái. */
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

/** Đặt theo từng dòng khi kiểm tra. GOOD về địa điểm bán được; DAMAGED về kho hàng hỏng của địa điểm đó (`Location.damagedLocationId`, `isSellable = false`). */
export const ReturnCondition = {
  GOOD: 'GOOD',
  DAMAGED: 'DAMAGED',
} as const;

export type ReturnCondition =
  (typeof ReturnCondition)[keyof typeof ReturnCondition];

export const RETURN_CONDITIONS: readonly string[] =
  Object.values(ReturnCondition);
