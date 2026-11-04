/** Một lần giao hàng. Giao thất bại được thử lại bằng Shipment mới, hoặc chuyển thành OrderReturn. */
export const ShipmentStatus = {
  CREATED: 'CREATED',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
} as const;

export type ShipmentStatus =
  (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

export const SHIPMENT_STATUSES: readonly string[] =
  Object.values(ShipmentStatus);

/**
 * Không trạng thái nào đưa chuyến giao ra khỏi nhóm này. FAILED cố ý không có: hàng vẫn ở shipper và có thể giao lại (-> DELIVERED) cho tới khi shop xác nhận đã nhận về (-> RETURNED).
 */
export const FINAL_SHIPMENT_STATUSES: readonly string[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
];

/** Chỉ đổi được tài xế khi hàng còn ở shop. Khi đơn đang SHIPPING, shipper đã chở hàng và đang cầm tiền cần thu; đổi lúc này sẽ giao cả hai cho người chưa nhận hàng. */
export const DRIVER_CHANGEABLE_STATUSES: readonly string[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
];

/** INTERNAL: shipper của shop xác nhận bằng ảnh minh chứng. EXTERNAL: đơn vị vận chuyển (hoặc logistics của sàn) báo DELIVERED; khi chưa có API vận chuyển thì nhân viên đánh dấu tay. */
export const CarrierType = {
  INTERNAL: 'INTERNAL',
  EXTERNAL: 'EXTERNAL',
} as const;

export type CarrierType = (typeof CarrierType)[keyof typeof CarrierType];

export const CARRIER_TYPES: readonly string[] = Object.values(CarrierType);

export const ShipmentEventSource = {
  MANUAL: 'MANUAL',
  CARRIER: 'CARRIER',
} as const;

export type ShipmentEventSource =
  (typeof ShipmentEventSource)[keyof typeof ShipmentEventSource];
