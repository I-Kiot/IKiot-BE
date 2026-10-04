/** Packing an order at its ship-from location. Stock is deducted when the person in charge verifies the packed goods are intact (`verifiedBy/At`), which is what moves it to PACKED; HANDED_OVER only records the hand-over and changes no stock. */
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

/** Before verification. Packing never touches stock, so cancelling here has nothing to give back. */
export const UNPACKED_FULFILLMENT_STATUSES: readonly string[] = [
  FulfillmentStatus.PENDING,
  FulfillmentStatus.PICKING,
  FulfillmentStatus.PICKED,
  FulfillmentStatus.PACKING,
];
