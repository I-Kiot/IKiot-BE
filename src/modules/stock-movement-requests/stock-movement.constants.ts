/** What a stock movement is for: `IMPORT` (goods from a supplier, the only type that moves their debt), `EXPORT` (between our own locations), `RETURN` (the same move back to a warehouse, kept separate because the paperwork and reporting differ) and `ADJUST` (a stocktake correcting the recorded number at one location). */
export const MovementType = {
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  RETURN: 'RETURN',
  ADJUST: 'ADJUST',
} as const;

export type MovementType = (typeof MovementType)[keyof typeof MovementType];

export const MOVEMENT_TYPES: readonly string[] = Object.values(MovementType);

/** The lifecycle of a request. `DRAFT → OPENING → CLOSED → IN_TRANSIT → RECEIVED` is the transfer path; IMPORT and ADJUST start at `PENDING`, since there is nothing to pick and pack, and ADJUST finishes at `COMPLETED` because nothing arrived. */
export const MovementStatus = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  OPENING: 'OPENING',
  CLOSED: 'CLOSED',
  IN_TRANSIT: 'IN_TRANSIT',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const;

export type MovementStatus =
  (typeof MovementStatus)[keyof typeof MovementStatus];

export const MOVEMENT_STATUSES: readonly string[] =
  Object.values(MovementStatus);

/** Statuses in which a movement still expects to touch its items; `ProductService` reads this to refuse discontinuing a product caught up in unfinished paperwork. */
export const OPEN_MOVEMENT_STATUSES: readonly string[] = [
  MovementStatus.DRAFT,
  MovementStatus.PENDING,
  MovementStatus.OPENING,
  MovementStatus.IN_TRANSIT,
];

/** Nothing moves a request out of these - cancelling one is refused. */
export const FINAL_MOVEMENT_STATUSES: readonly string[] = [
  MovementStatus.RECEIVED,
  MovementStatus.COMPLETED,
  MovementStatus.CANCELLED,
];

/** How much of a supplier's credit limit has to be used before the owners are warned - the hardcoded `0.75` from the old receive path, fired once on the receipt that crosses the line. */
export const CREDIT_WARNING_RATIO = 0.75;
