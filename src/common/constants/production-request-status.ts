/** A production request is a list for tracking and phoning the workshop - nothing is sent automatically. Staff move DRAFT → SENT or cancel by hand; PARTIALLY_RECEIVED and COMPLETED follow only from the receipts recorded against it (`POST /production-requests/:id/receive`). */
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

/** Requests still expecting goods, drafts included - everything the production list subtracts before calling a shortfall "not yet ordered". */
export const OPEN_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.DRAFT,
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

/** Sent to the workshop and not yet fully delivered - the list's `onOrderQuantity`. A DRAFT is counted apart (`draftQuantity`): nobody has called the workshop about it yet (contract §3). */
export const ON_ORDER_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

/** Where a receipt may be recorded. */
export const RECEIVABLE_PRODUCTION_REQUEST_STATUSES: readonly string[] =
  ON_ORDER_PRODUCTION_REQUEST_STATUSES;

/** The statuses a person may set by hand (`PATCH /production-requests/:id/status`). PARTIALLY_RECEIVED only ever follows from a receipt; COMPLETED does too, except for closing a partly delivered request short - the workshop will not make the rest (2026-10-05). */
export const MANUAL_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.CANCELLED,
  ProductionRequestStatus.COMPLETED,
];

/** Nothing moves a request out of these. */
export const FINAL_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];

/** A workshop's delivery note against a SENT / PARTIALLY_RECEIVED request (2026-10-09). PENDING touches no stock; RECEIVED is set only by the receiving location confirming it, which is when stock and the workshop's debt rise. */
export const ProductionDeliveryStatus = {
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;

export type ProductionDeliveryStatus =
  (typeof ProductionDeliveryStatus)[keyof typeof ProductionDeliveryStatus];

export const PRODUCTION_DELIVERY_STATUSES: readonly string[] = Object.values(
  ProductionDeliveryStatus,
);

/** What a workshop's staff see: everything already sent to their workshop. A DRAFT has not been sent, so it is still the shop's business. */
export const WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];
