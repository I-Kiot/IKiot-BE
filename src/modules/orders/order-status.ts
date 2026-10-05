import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

// The order journey's one transition rule (contract §2, A-1). The 2026-10-02 meeting dropped the
// reservation design, and deriveOrderStatus / deriveLineStatus went with it: an order's status is
// no longer computed from its lines, it is moved by a route, and every journey route moves it
// through assertTransition. The till (PATCH /orders/:id/status) is outside the journey and still
// uses VALID_ORDER_TRANSITIONS in order.constants.ts until A-2 moves it here.

/**
 * Where a journey order may go from where it is. A status missing from the keys, the deprecated
 * reservation-era ones and the till's legacy PENDING included, goes nowhere.
 *
 * - Cancelling is only allowed while the goods are still in `stock` (up to PICKED_UP) - decided
 *   2026-10-05 with A-5 (`OrderCancelService`).
 * - RETURNED is reached from any status where stock has already been deducted, and only when every
 *   line has come back (§5 inspect). A partial return leaves the order where it was.
 */
export const ORDER_JOURNEY_TRANSITIONS: Readonly<
  Partial<Record<string, readonly OrderStatus[]>>
> = {
  [OrderStatus.PENDING_CONFIRMATION]: [
    OrderStatus.CONFIRMED, // A-3
    OrderStatus.CANCELLED, // Shopee cancelled it (E-3)
  ],
  [OrderStatus.CONFIRMED]: [
    OrderStatus.PACKED, // C-1 pack: goods locked
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PACKED]: [
    OrderStatus.PICKED_UP, // C-2 POST /shipments
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.PICKED_UP]: [
    OrderStatus.SHIPPING, // C-2 ship: locked goods leave stock
    OrderStatus.CANCELLED,
  ],
  [OrderStatus.SHIPPING]: [
    OrderStatus.RECEIVED, // deliver, cash collected (A-10)
    OrderStatus.COMPLETED, // deliver, QR / nothing left to collect (A-10)
    OrderStatus.RETURNED, // delivery failed, everything came back
  ],
  [OrderStatus.RECEIVED]: [
    OrderStatus.COMPLETED, // confirm-remittance (A-10)
    OrderStatus.RETURNED,
  ],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

export function canTransition(from: string, to: OrderStatus): boolean {
  return ORDER_JOURNEY_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Throws ORDER_STATUS_TRANSITION_INVALID (409) unless a journey order may move `from` → `to`.
 * It only checks the step. The write must still claim the row with
 * `updateMany({ where: { status: from } })`, because two requests can both pass this check.
 */
export function assertTransition(from: string, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
      message: `An order cannot move from ${from} to ${to}`,
    });
  }
}
