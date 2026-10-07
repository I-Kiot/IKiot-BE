/** One delivery attempt. A failed attempt is retried with a new Shipment or turned into an OrderReturn. */
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

/** Nothing moves a shipment out of these. */
export const FINAL_SHIPMENT_STATUSES: readonly string[] = [
  ShipmentStatus.DELIVERED,
  ShipmentStatus.FAILED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.CANCELLED,
];

/** The driver can be swapped only while the goods are still with us. Once the order is SHIPPING (IN_TRANSIT / OUT_FOR_DELIVERY) the shipper is on the road with them, and changing it would hand the goods - and the cash they are about to collect - to someone who never took them. */
export const DRIVER_CHANGEABLE_STATUSES: readonly string[] = [
  ShipmentStatus.CREATED,
  ShipmentStatus.PICKED_UP,
];

/** INTERNAL: our own shipper confirms with proof photos. EXTERNAL: a carrier (or the marketplace's logistics) reports DELIVERED - or, with no carrier API, staff mark it by hand. */
export const CarrierType = {
  INTERNAL: 'INTERNAL',
  EXTERNAL: 'EXTERNAL',
} as const;

export type CarrierType = (typeof CarrierType)[keyof typeof CarrierType];

export const CARRIER_TYPES: readonly string[] = Object.values(CarrierType);

/** Who wrote a ShipmentEvent. */
export const ShipmentEventSource = {
  MANUAL: 'MANUAL',
  CARRIER: 'CARRIER',
} as const;

export type ShipmentEventSource =
  (typeof ShipmentEventSource)[keyof typeof ShipmentEventSource];
