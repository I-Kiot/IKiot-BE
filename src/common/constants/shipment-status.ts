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
