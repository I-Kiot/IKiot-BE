import {
  FINAL_PRODUCTION_REQUEST_STATUSES,
  ProductionRequestStatus,
} from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';

// The production request's lifecycle as pure functions - the one place every status change is
// decided (contract §3), unit-tested in production-request-rules.spec.ts.
//
//   DRAFT ──SENT──▶ SENT ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ COMPLETED
//     │               │                       │
//     └──CANCELLED◀───┘                       └──close short (by hand, with a reason)──▶ COMPLETED
//        (only while nothing has been received)
//
// Closing short exists because a workshop that delivers 8 of 10 and stops would otherwise
// leave the request open for ever, its last 2 still counted as "on order" on the production
// list - so the shortage it should be showing stays hidden. Once closed, the remainder stops
// counting and the list shows that SKU short again, ready to order elsewhere.

export type RuleViolation = { code: ErrorCode; message: string };

/** A status somebody sets by hand. Returns the reason it is refused, or null. A request that has delivered goods cannot be cancelled: stock already came in against it, and cancelling would stop explaining where those goods came from - it is closed short instead, which keeps the receipts and drops only what never came. */
export function manualTransitionViolation(
  from: string,
  to: string,
  receivedAny: boolean,
  reason?: string | null,
): RuleViolation | null {
  if (FINAL_PRODUCTION_REQUEST_STATUSES.includes(from)) {
    return {
      code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
      message: `A ${from} production request cannot change status`,
    };
  }
  if (to === ProductionRequestStatus.SENT) {
    return from === ProductionRequestStatus.DRAFT
      ? null
      : {
          code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
          message: 'Only a DRAFT production request can be sent',
        };
  }
  if (to === ProductionRequestStatus.CANCELLED) {
    return receivedAny
      ? {
          code: ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS,
          message:
            'Goods have already been received against this production request; close it short instead of cancelling',
        }
      : null;
  }
  if (to === ProductionRequestStatus.COMPLETED) {
    // Only a request that has delivered something and is still owed the rest. Nothing received
    // yet is a cancellation, not a short close.
    if (from !== ProductionRequestStatus.PARTIALLY_RECEIVED) {
      return {
        code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
        message:
          'Only a partly received production request can be closed short; cancel one that has received nothing',
      };
    }
    return reason?.trim()
      ? null
      : {
          code: ErrorCode.PRODUCTION_REQUEST_CLOSE_REASON_REQUIRED,
          message: 'Closing a production request short needs a reason (note)',
        };
  }
  return {
    code: ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
    message: `${to} follows from receiving goods and cannot be set by hand`,
  };
}

/** Where a receipt leaves the request: COMPLETED once every line has all it asked for, PARTIALLY_RECEIVED otherwise. */
export function statusAfterReceipt(
  lines: { quantity: number; receivedQuantity: number }[],
): string {
  return lines.every((line) => line.receivedQuantity >= line.quantity)
    ? ProductionRequestStatus.COMPLETED
    : ProductionRequestStatus.PARTIALLY_RECEIVED;
}

/** The next YCSX code after the highest one in the shop: `YCSX000123` → `YCSX000124`. Codes are always server-made, so every one matches the pattern; anything else is ignored rather than trusted. */
export const PRODUCTION_REQUEST_CODE_PREFIX = 'YCSX';

export function nextProductionRequestCode(
  existing: string | null | undefined,
  step = 1,
): string {
  const digits = existing?.startsWith(PRODUCTION_REQUEST_CODE_PREFIX)
    ? existing.slice(PRODUCTION_REQUEST_CODE_PREFIX.length)
    : '';
  const current = /^\d+$/.test(digits) ? Number(digits) : 0;
  return `${PRODUCTION_REQUEST_CODE_PREFIX}${String(current + step).padStart(6, '0')}`;
}
