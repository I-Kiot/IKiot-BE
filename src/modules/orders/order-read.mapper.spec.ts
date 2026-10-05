import {
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  amountDueOf,
  collectionOf,
  depositOf,
  toUserRef,
} from './order-read.mapper';

describe('toUserRef', () => {
  const user = {
    id: 'u1',
    phoneNumber: '0900000001',
    profileFirstName: 'Lan',
    profileLastName: 'Nguyễn',
  };

  it('puts the name together from the profile', () => {
    expect(toUserRef(user)).toEqual({
      id: 'u1',
      name: 'Lan Nguyễn',
      phoneNumber: '0900000001',
    });
  });

  it('falls back to the phone number for an account with no name', () => {
    expect(
      toUserRef({ ...user, profileFirstName: null, profileLastName: null })
        ?.name,
    ).toBe('0900000001');
  });

  it('is null for nobody', () => {
    expect(toUserRef(null)).toBeNull();
  });
});

describe('amountDueOf', () => {
  it('is the total less the deposit', () => {
    expect(amountDueOf(1_000_000, 300_000)).toBe(700_000);
  });

  it('is the whole total with no deposit', () => {
    expect(amountDueOf(1_000_000, null)).toBe(1_000_000);
  });

  it('is zero for a fully deposited order', () => {
    expect(amountDueOf(1_000_000, 1_000_000)).toBe(0);
  });
});

describe('depositOf', () => {
  it('is null when there was no deposit', () => {
    expect(depositOf(null, null)).toBeNull();
  });

  it('keeps the percent when the deposit was typed as one', () => {
    expect(depositOf(300_000, 30)).toEqual({ amount: 300_000, percent: 30 });
  });

  it('has a null percent when the deposit was typed as an amount', () => {
    expect(depositOf(300_000, null)).toEqual({
      amount: 300_000,
      percent: null,
    });
  });
});

describe('collectionOf', () => {
  const shipper = {
    id: 's1',
    phoneNumber: '0900000002',
    profileFirstName: 'Hùng',
    profileLastName: null,
  };
  const paidAt = new Date('2026-10-05T03:00:00Z');

  const balance = (over: Record<string, unknown> = {}) => ({
    method: 'CASH',
    amount: 700_000,
    paidAt,
    createdAt: paidAt,
    collectedBy: shipper,
    remittanceStatus: RemittanceStatus.PENDING,
    remittanceConfirmedBy: null,
    remittanceConfirmedAt: null,
    ...over,
  });

  const order = (
    status: string,
    payments: ReturnType<typeof balance>[] = [],
    shippedAt: Date | null = paidAt,
  ) => ({ status, shippedAt, payments }) as never;

  it('is null until the order is delivered', () => {
    expect(collectionOf(order(OrderStatus.SHIPPING), 700_000)).toBeNull();
  });

  it('reads cash a shipper still holds from the BALANCE payment', () => {
    expect(
      collectionOf(order(OrderStatus.RECEIVED, [balance()]), 700_000),
    ).toEqual({
      method: 'CASH',
      amount: 700_000,
      collectedBy: { id: 's1', name: 'Hùng', phoneNumber: '0900000002' },
      collectedAt: paidAt,
      cashRemittanceStatus: RemittanceStatus.PENDING,
      remittanceConfirmedBy: null,
      remittanceConfirmedAt: null,
    });
  });

  it('reads anything that is not cash as a QR transfer', () => {
    for (const method of ['BANK_TRANSFER', 'SEPAY']) {
      expect(
        collectionOf(
          order(OrderStatus.COMPLETED, [
            balance({
              method,
              remittanceStatus: RemittanceStatus.NOT_APPLICABLE,
            }),
          ]),
          700_000,
        )?.method,
      ).toBe('BANK_TRANSFER_QR');
    }
  });

  it('shows a fully deposited, delivered order as collected with nothing to collect', () => {
    expect(collectionOf(order(OrderStatus.COMPLETED), 0)).toMatchObject({
      method: 'NONE',
      amount: 0,
      cashRemittanceStatus: RemittanceStatus.NOT_APPLICABLE,
    });
  });

  it('does not invent a collection for an order that never shipped', () => {
    // A till sale is COMPLETED with nothing due and no shipment - not a delivery.
    expect(collectionOf(order(OrderStatus.COMPLETED, [], null), 0)).toBeNull();
  });
});
