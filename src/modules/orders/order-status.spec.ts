import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  assertTransition,
  canTransition,
  ORDER_JOURNEY_TRANSITIONS,
} from './order-status';

const S = OrderStatus;

// The journey diagram in contract §2, written out as the only steps that exist.
const ALLOWED: [string, OrderStatus][] = [
  [S.PENDING_CONFIRMATION, S.CONFIRMED],
  [S.PENDING_CONFIRMATION, S.CANCELLED],
  [S.CONFIRMED, S.PACKED],
  [S.CONFIRMED, S.CANCELLED],
  [S.PACKED, S.PICKED_UP],
  [S.PACKED, S.CANCELLED],
  [S.PICKED_UP, S.SHIPPING],
  [S.PICKED_UP, S.CANCELLED],
  [S.SHIPPING, S.RECEIVED],
  [S.SHIPPING, S.COMPLETED],
  [S.SHIPPING, S.RETURNED],
  [S.RECEIVED, S.COMPLETED],
  [S.RECEIVED, S.RETURNED],
  [S.COMPLETED, S.RETURNED],
];

const ALL = Object.values(OrderStatus);
const key = (from: string, to: string) => `${from}→${to}`;
const allowed = new Set(ALLOWED.map(([f, t]) => key(f, t)));

describe('ORDER_JOURNEY_TRANSITIONS', () => {
  it('allows exactly the steps of the journey and nothing else', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect([key(from, to), canTransition(from, to)]).toEqual([
          key(from, to),
          allowed.has(key(from, to)),
        ]);
      }
    }
  });

  it('never cancels once the goods have left stock - from SHIPPING on it is a return', () => {
    for (const from of [S.SHIPPING, S.RECEIVED, S.COMPLETED]) {
      expect(canTransition(from, S.CANCELLED)).toBe(false);
    }
  });

  it('never returns an order whose stock was never deducted', () => {
    for (const from of [
      S.PENDING_CONFIRMATION,
      S.CONFIRMED,
      S.PACKED,
      S.PICKED_UP,
    ]) {
      expect(canTransition(from, S.RETURNED)).toBe(false);
    }
  });

  it('keeps CANCELLED and RETURNED terminal', () => {
    expect(ORDER_JOURNEY_TRANSITIONS[S.CANCELLED]).toEqual([]);
    expect(ORDER_JOURNEY_TRANSITIONS[S.RETURNED]).toEqual([]);
  });

  it('gives the deprecated and the till-only statuses no way into the journey', () => {
    for (const from of [S.PENDING, S.DRAFT, S.READY_TO_PACK, S.DELIVERED]) {
      expect(ORDER_JOURNEY_TRANSITIONS[from]).toBeUndefined();
    }
    for (const from of ALL) {
      for (const to of [S.PENDING, S.DRAFT, S.READY_TO_PACK, S.DELIVERED]) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('treats a status it has never heard of as going nowhere', () => {
    expect(canTransition('SOMETHING_ELSE', S.CONFIRMED)).toBe(false);
  });
});

describe('assertTransition', () => {
  it('passes a valid step', () => {
    expect(() => assertTransition(S.CONFIRMED, S.PACKED)).not.toThrow();
  });

  it('rejects an invalid step with a 409 carrying ORDER_STATUS_TRANSITION_INVALID', () => {
    let thrown: unknown;
    try {
      assertTransition(S.CONFIRMED, S.SHIPPING);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toMatchObject({
      code: ErrorCode.ORDER_STATUS_TRANSITION_INVALID,
    });
  });

  it('rejects staying put - a no-op is not a transition', () => {
    for (const status of ALL) {
      expect(() => assertTransition(status, status)).toThrow(ConflictException);
    }
  });
});
