/** Đóng gói tại địa điểm xuất hàng. PACKED (sau khi xác nhận hàng nguyên vẹn) khoá hàng khỏi kệ qua `inventories.locked_stock`; hàng chỉ rời `stock` khi đơn chuyển SHIPPING. HANDED_OVER chỉ ghi nhận bàn giao, không đổi kho. */
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
