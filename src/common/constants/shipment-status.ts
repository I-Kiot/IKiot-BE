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

/** Chuyến giao chưa kết thúc; FAILED vẫn giao lại được. */
export const FINAL_SHIPMENT_STATUSES: readonly string[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
];

/** Chỉ đổi tài xế khi shipper chưa lấy hàng. */
export const DRIVER_CHANGEABLE_STATUSES: readonly string[] = [
  ShipmentStatus.CREATED,
];

/** Kiểu giao: shipper nội bộ xác nhận bằng ảnh, đơn vị ngoài báo đã giao. */
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
