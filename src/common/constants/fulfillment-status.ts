/** Trạng thái đóng gói: PACKED khoá hàng khỏi kệ, hàng chỉ rời kho khi đơn SHIPPING. */
export const FulfillmentStatus = {
  PENDING: 'PENDING',
  PICKING: 'PICKING',
  PICKED: 'PICKED',
  PACKING: 'PACKING',
  PACKED: 'PACKED',
  HANDED_OVER: 'HANDED_OVER',
  EXCEPTION: 'EXCEPTION',
  CANCELLED: 'CANCELLED',
} as const;

export type FulfillmentStatus =
  (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

export const FULFILLMENT_STATUSES: readonly string[] =
  Object.values(FulfillmentStatus);
