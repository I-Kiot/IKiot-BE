import { ErrorCode } from '../../common/errors/error-codes';
import {
  FulfillmentType,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import {
  assertFulfillmentTypeChangeAllowed,
  assertNoPickupShippingFee,
  assertNotStorePickup,
  assertPickupReady,
  assertStorePickup,
  isPickupOverdue,
  pickupAmountDue,
} from './order-pickup.rules';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { getResponse(): { code: string } }).getResponse().code;
  }
  return undefined;
};

describe('assertStorePickup', () => {
  it('accepts a store pickup order', () => {
    expect(() =>
      assertStorePickup({ fulfillmentType: FulfillmentType.STORE_PICKUP }),
    ).not.toThrow();
  });

  it.each([FulfillmentType.HOME_DELIVERY, FulfillmentType.TAKEAWAY])(
    'rejects %s',
    (fulfillmentType) => {
      expect(codeOf(() => assertStorePickup({ fulfillmentType }))).toBe(
        ErrorCode.ORDER_NOT_STORE_PICKUP,
      );
    },
  );
});

describe('assertNotStorePickup', () => {
  it('refuses a shipment for a pickup order only', () => {
    expect(
      codeOf(() =>
        assertNotStorePickup({ fulfillmentType: FulfillmentType.STORE_PICKUP }),
      ),
    ).toBe(ErrorCode.SHIPMENT_NOT_FOR_PICKUP);
    expect(() =>
      assertNotStorePickup({ fulfillmentType: FulfillmentType.HOME_DELIVERY }),
    ).not.toThrow();
  });
});

describe('assertPickupReady', () => {
  it('accepts a packed order', () => {
    expect(() =>
      assertPickupReady({ status: OrderStatus.PACKED }),
    ).not.toThrow();
  });

  it.each([
    OrderStatus.CONFIRMED,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ])('rejects %s', (status) => {
    expect(codeOf(() => assertPickupReady({ status }))).toBe(
      ErrorCode.ORDER_PICKUP_NOT_READY,
    );
  });
});

describe('assertNoPickupShippingFee', () => {
  it('accepts zero and rejects any fee', () => {
    expect(() => assertNoPickupShippingFee(0)).not.toThrow();
    expect(codeOf(() => assertNoPickupShippingFee(30000))).toBe(
      ErrorCode.ORDER_PICKUP_NO_SHIPPING_FEE,
    );
  });
});

describe('pickupAmountDue', () => {
  const paid = (kind: string, amount: number) => ({
    kind,
    amount,
    status: PaymentRecordStatus.PAID,
  });

  it('is the whole total when nothing was paid', () => {
    expect(pickupAmountDue(1_000_000, [])).toBe(1_000_000);
  });

  it('subtracts the deposit and the balance already collected', () => {
    expect(
      pickupAmountDue(1_000_000, [
        paid(PaymentKind.DEPOSIT, 300_000),
        paid(PaymentKind.BALANCE, 200_000),
      ]),
    ).toBe(500_000);
  });

  it('ignores a QR payment still waiting for its transfer', () => {
    expect(
      pickupAmountDue(1_000_000, [
        { kind: PaymentKind.BALANCE, amount: 700_000, status: 'PENDING' },
        paid(PaymentKind.DEPOSIT, 300_000),
      ]),
    ).toBe(700_000);
  });

  it('adds back a refunded amount and never goes below zero', () => {
    expect(
      pickupAmountDue(1_000_000, [
        paid(PaymentKind.DEPOSIT, 400_000),
        paid(PaymentKind.REFUND, 100_000),
      ]),
    ).toBe(700_000);
    expect(
      pickupAmountDue(1_000_000, [paid(PaymentKind.FULL, 1_200_000)]),
    ).toBe(0);
  });
});

describe('isPickupOverdue', () => {
  const base = {
    fulfillmentType: FulfillmentType.STORE_PICKUP,
    status: OrderStatus.PACKED,
    requestedDeliveryDate: new Date('2026-11-04T00:00:00.000Z'),
  };
  // 2026-11-05 09:00 giờ Việt Nam.
  const now = new Date('2026-11-05T02:00:00.000Z');

  it('flags a packed order whose pickup day has passed', () => {
    expect(isPickupOverdue(base, now)).toBe(true);
  });

  it('is not overdue on the pickup day itself', () => {
    expect(
      isPickupOverdue(
        {
          ...base,
          requestedDeliveryDate: new Date('2026-11-05T00:00:00.000Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('counts the Vietnam day: 18:00 UTC is already the next day there', () => {
    const lateUtc = new Date('2026-11-04T18:00:00.000Z');
    expect(isPickupOverdue(base, lateUtc)).toBe(true);
  });

  it('leaves other statuses, other delivery types and undated orders alone', () => {
    expect(
      isPickupOverdue({ ...base, status: OrderStatus.CONFIRMED }, now),
    ).toBe(false);
    expect(
      isPickupOverdue(
        { ...base, fulfillmentType: FulfillmentType.HOME_DELIVERY },
        now,
      ),
    ).toBe(false);
    expect(isPickupOverdue({ ...base, requestedDeliveryDate: null }, now)).toBe(
      false,
    );
  });
});

describe('assertFulfillmentTypeChangeAllowed', () => {
  const pickup = FulfillmentType.STORE_PICKUP;
  const home = FulfillmentType.HOME_DELIVERY;

  it('lets a confirmed order switch either way', () => {
    const order = { status: OrderStatus.CONFIRMED, fulfillmentType: pickup };
    expect(() =>
      assertFulfillmentTypeChangeAllowed(order, home, 0),
    ).not.toThrow();
  });

  it('lets a packed order switch while it has no shipment', () => {
    const order = { status: OrderStatus.PACKED, fulfillmentType: pickup };
    expect(() =>
      assertFulfillmentTypeChangeAllowed(order, home, 0),
    ).not.toThrow();
  });

  it('locks a packed order that already has a shipment', () => {
    const order = { status: OrderStatus.PACKED, fulfillmentType: home };
    expect(
      codeOf(() => assertFulfillmentTypeChangeAllowed(order, pickup, 1)),
    ).toBe(ErrorCode.ORDER_FULFILLMENT_TYPE_LOCKED);
  });

  it('locks an order whose goods were handed to a shipper', () => {
    const order = { status: OrderStatus.PICKED_UP, fulfillmentType: home };
    expect(
      codeOf(() => assertFulfillmentTypeChangeAllowed(order, pickup, 1)),
    ).toBe(ErrorCode.ORDER_FULFILLMENT_TYPE_LOCKED);
  });

  it('does not touch a change that has nothing to do with pickup', () => {
    const order = { status: OrderStatus.PICKED_UP, fulfillmentType: home };
    expect(() =>
      assertFulfillmentTypeChangeAllowed(order, FulfillmentType.TAKEAWAY, 1),
    ).not.toThrow();
  });
});
