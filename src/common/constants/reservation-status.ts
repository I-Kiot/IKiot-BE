/** A StockReservation's life. Holding stock only lowers what can be sold (`Inventory.reserved`); the stock itself leaves when the line is packed, which turns the hold CONSUMED. */
export const ReservationStatus = {
  ACTIVE: 'ACTIVE',
  /** The line was packed and the stock deducted. */
  CONSUMED: 'CONSUMED',
  /** Handed back - the order was cancelled, the line turned custom, or the hold moved elsewhere. */
  RELEASED: 'RELEASED',
} as const;

export type ReservationStatus =
  (typeof ReservationStatus)[keyof typeof ReservationStatus];

export const RESERVATION_STATUSES: readonly string[] =
  Object.values(ReservationStatus);
