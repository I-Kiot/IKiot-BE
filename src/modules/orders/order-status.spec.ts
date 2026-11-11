import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  assertTransition,
  canTransition,
  completedData,
  nextStatusAfterPayment,
  ORDER_JOURNEY_TRANSITIONS,
} from './order-status';

const S = OrderStatus;

// Sơ đồ hành trình ở contract §2, viết ra thành các bước duy nhất có thật.
const ALLOWED: [string, OrderStatus][] = [
  [S.PENDING_CONFIRMATION, S.CONFIRMED],
  [S.PENDING_CONFIRMATION, S.CANCELLED],
  [S.CONFIRMED, S.PACKED],
  [S.CONFIRMED, S.CANCELLED],
  [S.PACKED, S.PICKED_UP],
  [S.PACKED, S.COMPLETED], // khách tới lấy
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

describe('completedData', () => {
  it('writes status and completedAt together, from one clock reading', () => {
    const now = new Date('2026-11-11T03:00:00.000Z');
    expect(completedData(now)).toEqual({
      status: S.COMPLETED,
      completedAt: now,
    });
  });
});

describe('nextStatusAfterPayment', () => {
  const PAID = { status: 'PAID' };
  const till = { status: S.PENDING, fulfillmentType: 'TAKEAWAY' };
  const home = { status: S.RECEIVED, fulfillmentType: 'HOME_DELIVERY' };
  const pickup = { status: S.PACKED, fulfillmentType: 'STORE_PICKUP' };

  it('completes a counter sale waiting for its transfer once it is fully paid', () => {
    expect(nextStatusAfterPayment(till, PAID, false)).toBe(S.COMPLETED);
  });

  it('completes a delivered order once paid and no shipper cash is still held', () => {
    expect(nextStatusAfterPayment(home, PAID, false)).toBe(S.COMPLETED);
    expect(nextStatusAfterPayment(home, PAID, true)).toBeNull();
  });

  it('never moves a pickup order: the clerk hands the goods over', () => {
    expect(nextStatusAfterPayment(pickup, PAID, false)).toBeNull();
  });

  it('does not move an order that is not fully paid', () => {
    for (const status of ['PARTIALLY_PAID', 'UNPAID', 'PARTIALLY_REFUNDED']) {
      expect(nextStatusAfterPayment(till, { status }, false)).toBeNull();
      expect(nextStatusAfterPayment(home, { status }, false)).toBeNull();
    }
  });

  it('does not move an order that is not at the waiting step (cancelled, returned, completed)', () => {
    for (const status of [S.CANCELLED, S.RETURNED, S.COMPLETED]) {
      expect(
        nextStatusAfterPayment({ ...till, status }, PAID, false),
      ).toBeNull();
      expect(
        nextStatusAfterPayment({ ...home, status }, PAID, false),
      ).toBeNull();
    }
  });
});
