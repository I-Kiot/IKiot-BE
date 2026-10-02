/** A production request is a list for tracking and phoning the workshop - nothing is sent automatically. Staff move it by hand; PARTIALLY_RECEIVED and COMPLETED also follow from the WORKSHOP imports received against it. */
export const ProductionRequestStatus = {
  DRAFT: 'DRAFT',
  /** The workshop has been called. Custom specs are locked from here. */
  SENT: 'SENT',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type ProductionRequestStatus =
  (typeof ProductionRequestStatus)[keyof typeof ProductionRequestStatus];

export const PRODUCTION_REQUEST_STATUSES: readonly string[] = Object.values(
  ProductionRequestStatus,
);

/** Requests still expecting goods - what the shortage alert subtracts as "already on order". */
export const OPEN_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.DRAFT,
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

/** Nothing moves a request out of these. */
export const FINAL_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];
