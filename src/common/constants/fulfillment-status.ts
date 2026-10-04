/** Packing an order at its ship-from location. When the person in charge verifies the packed goods are intact (`verifiedBy/At`) the fulfillment moves to PACKED and its items are locked out of the shelf (`inventories.locked_stock`); they leave `stock` only when the order moves to SHIPPING. HANDED_OVER only records the hand-over and changes no stock. A PACKED / HANDED_OVER fulfillment of an order not yet shipped is the record of that lock. */
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
