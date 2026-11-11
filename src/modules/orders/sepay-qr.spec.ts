import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  assertQrPayable,
  buildSepayTransfer,
  decideSepayTransfer,
  effectiveQrStatus,
  isAwaitingQrTransfer,
  isQrExpired,
  newQrExpiresAt,
  qrExpiresAt,
  qrIssuedBefore,
  SEPAY_QR_TTL_MINUTES,
  sepayDedupeKey,
  sepayQrView,
  sepayTransferFromPayload,
} from './sepay-qr';
import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
} from '../../common/constants/order-status';
import {
  PaymentRecordStatus,
  SepayRejectReason,
} from '../../common/constants/payment-method';
import { ErrorCode } from '../../common/errors/error-codes';

const MIN = 60_000;
const T0 = new Date('2026-11-10T03:00:00.000Z');
const at = (minutes: number, extraMs = 0) =>
  new Date(T0.getTime() + minutes * MIN + extraMs);
const banking = {
  bankingBankName: 'MB',
  bankingAccountNumber: '0123456789',
  bankingAccountName: 'SHOP',
};
const qr = { createdAt: T0, amount: 1000, reference: 'ORDABC12345' };

describe('qrExpiresAt', () => {
  it('uses expiresAt when present', () => {
    expect(qrExpiresAt({ createdAt: T0, expiresAt: at(5) })).toEqual(at(5));
  });
  it('falls back to createdAt + 15 minutes', () => {
    expect(SEPAY_QR_TTL_MINUTES).toBe(15);
    expect(qrExpiresAt({ createdAt: T0 })).toEqual(at(15));
    expect(qrExpiresAt({ createdAt: T0, expiresAt: null })).toEqual(at(15));
  });
  it('newQrExpiresAt is now + TTL and qrIssuedBefore is now - TTL', () => {
    expect(newQrExpiresAt(T0)).toEqual(at(15));
    expect(qrIssuedBefore(at(15))).toEqual(T0);
  });
});

describe('isQrExpired', () => {
  it('is false 1ms before the deadline and true exactly at it', () => {
    expect(isQrExpired({ createdAt: T0 }, at(15, -1))).toBe(false);
    expect(isQrExpired({ createdAt: T0 }, at(15))).toBe(true);
    expect(isQrExpired({ createdAt: T0 }, at(16))).toBe(true);
  });
});

describe('assertQrPayable', () => {
  it('passes while live and throws QR_PAYMENT_EXPIRED once expired', () => {
    expect(() => assertQrPayable({ createdAt: T0 }, at(14))).not.toThrow();
    try {
      assertQrPayable({ createdAt: T0 }, at(15));
      throw new Error('should have thrown');
    } catch (error) {
      const body = (
        error as {
          getResponse(): { code: string; errors: { expiresAt: string } };
        }
      ).getResponse();
      expect(body.code).toBe(ErrorCode.QR_PAYMENT_EXPIRED);
      expect(body.errors.expiresAt).toBe(at(15).toISOString());
    }
  });
});

describe('sepayQrView', () => {
  it('gives a URL while live, in both modes', () => {
    const issued = sepayQrView(banking, qr, 'issue', at(1));
    expect(issued.qrUrl).toContain('img.vietqr.io');
    expect(issued.qrUrl).toContain('ORDABC12345');
    expect(issued.expired).toBe(false);
    expect(issued.expiresAt).toEqual(at(15));
    expect(sepayQrView(banking, qr, 'read', at(1)).qrUrl).toBe(issued.qrUrl);
  });
  it('read of an expired code has no URL', () => {
    const view = sepayQrView(banking, qr, 'read', at(20));
    expect(view).toEqual({ qrUrl: null, expiresAt: at(15), expired: true });
  });
  it('read without banking has no URL', () => {
    expect(sepayQrView(null, qr, 'read', at(1)).qrUrl).toBeNull();
  });
  it('issue of an expired code throws instead of handing out a dead code', () => {
    expect(() => sepayQrView(banking, qr, 'issue', at(15))).toThrow();
  });
});

describe('effectiveQrStatus', () => {
  it('reports a PENDING row past its deadline as EXPIRED', () => {
    const row = { createdAt: T0, status: PaymentRecordStatus.PENDING };
    expect(effectiveQrStatus(row, at(1))).toBe('PENDING');
    expect(effectiveQrStatus(row, at(15))).toBe('EXPIRED');
  });
  it('leaves every other status alone', () => {
    for (const status of ['PAID', 'CANCELLED', 'EXPIRED', 'FAILED']) {
      expect(effectiveQrStatus({ createdAt: T0, status }, at(60))).toBe(status);
    }
  });
});

describe('isAwaitingQrTransfer', () => {
  const home = {
    status: OrderStatus.RECEIVED,
    fulfillmentType: FulfillmentType.HOME_DELIVERY,
    paymentStatus: OrderPaymentStatus.UNPAID,
  };
  const pickup = {
    status: OrderStatus.PACKED,
    fulfillmentType: FulfillmentType.STORE_PICKUP,
    paymentStatus: OrderPaymentStatus.UNPAID,
  };
  it('delivery: open payment on a RECEIVED order', () => {
    expect(isAwaitingQrTransfer({ status: 'PENDING' }, home)).toBe(true);
    expect(isAwaitingQrTransfer({ status: 'EXPIRED' }, home)).toBe(true);
    expect(isAwaitingQrTransfer({ status: 'CANCELLED' }, home)).toBe(false);
    expect(isAwaitingQrTransfer({ status: 'PAID' }, home)).toBe(false);
    expect(
      isAwaitingQrTransfer(
        { status: 'PENDING' },
        { ...home, status: OrderStatus.COMPLETED },
      ),
    ).toBe(false);
  });
  it('counter sale: open payment on a PENDING order', () => {
    const till = {
      status: OrderStatus.PENDING,
      fulfillmentType: FulfillmentType.TAKEAWAY,
      paymentStatus: OrderPaymentStatus.PARTIALLY_PAID,
    };
    expect(isAwaitingQrTransfer({ status: 'PENDING' }, till)).toBe(true);
    expect(isAwaitingQrTransfer({ status: 'EXPIRED' }, till)).toBe(true);
    expect(isAwaitingQrTransfer({ status: 'CANCELLED' }, till)).toBe(false);
    for (const status of [OrderStatus.COMPLETED, OrderStatus.CANCELLED]) {
      expect(
        isAwaitingQrTransfer({ status: 'PENDING' }, { ...till, status }),
      ).toBe(false);
    }
  });
  it('pickup: PACKED and not yet paid', () => {
    expect(isAwaitingQrTransfer({ status: 'PENDING' }, pickup)).toBe(true);
    expect(
      isAwaitingQrTransfer(
        { status: 'PENDING' },
        { ...pickup, paymentStatus: OrderPaymentStatus.PAID },
      ),
    ).toBe(false);
    expect(
      isAwaitingQrTransfer(
        { status: 'PENDING' },
        { ...pickup, status: OrderStatus.CANCELLED },
      ),
    ).toBe(false);
  });
});

describe('decideSepayTransfer', () => {
  const base = {
    expired: false,
    waiting: true,
    amountDue: 1000,
    transferAmount: 1000,
    rejectReason: SepayRejectReason.ORDER_NOT_WAITING,
  };
  it('settles a live, waiting, fully paid transfer', () => {
    expect(decideSepayTransfer(base)).toEqual({
      action: 'SETTLE',
      late: false,
      partial: false,
    });
  });
  it('settles late when the code expired but the order still waits', () => {
    expect(decideSepayTransfer({ ...base, expired: true })).toEqual({
      action: 'SETTLE',
      late: true,
      partial: false,
    });
  });
  it('an overpayment is still a plain settle (the excess comes from the derived status)', () => {
    expect(decideSepayTransfer({ ...base, transferAmount: 1500 })).toEqual({
      action: 'SETTLE',
      late: false,
      partial: false,
    });
  });
  it('rejects whenever nothing waits, expired or not, with the given reason', () => {
    for (const expired of [true, false]) {
      expect(
        decideSepayTransfer({
          ...base,
          expired,
          waiting: false,
          rejectReason: SepayRejectReason.ORDER_CANCELLED,
        }),
      ).toEqual({ action: 'REJECT', reason: 'ORDER_CANCELLED' });
    }
  });
  it('a short transfer settles as a partial payment (it is money that really arrived)', () => {
    expect(decideSepayTransfer({ ...base, transferAmount: 999 })).toEqual({
      action: 'SETTLE',
      late: false,
      partial: true,
    });
    expect(
      decideSepayTransfer({ ...base, transferAmount: 400, expired: true }),
    ).toEqual({ action: 'SETTLE', late: true, partial: true });
  });
  it('rejection wins over shortness', () => {
    expect(
      decideSepayTransfer({ ...base, waiting: false, transferAmount: 1 })
        .action,
    ).toBe('REJECT');
  });
});

/** Mọi mã QR phải qua `sepayQrView`: ngoài file định nghĩa và `sepay-qr.ts`, không file nào được gọi thẳng hàm dựng link VietQR. */
describe('buildSepayQrUrl gate', () => {
  const SRC = join(__dirname, '..', '..');
  function tsFilesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return tsFilesUnder(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });
  }

  it('is called only from sepay-qr.ts (and defined in tenant-banking.ts)', () => {
    const callers = tsFilesUnder(SRC)
      .filter((path) => readFileSync(path, 'utf8').includes('buildSepayQrUrl('))
      .map((path) => path.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual([
      'modules/orders/sepay-qr.ts',
      'modules/orders/tenant-banking.ts',
    ]);
  });
});

describe('sepayDedupeKey', () => {
  const base = {
    accountNumber: '0123456789',
    transactionDate: '2026-11-11 10:00:00',
    amount: 500000,
    content: 'ORD123456 thanh toan',
  };
  it('prefers the SePay transaction id', () => {
    expect(
      sepayDedupeKey({
        ...base,
        sepayTransactionId: '9001',
        bankReferenceCode: 'FT123',
      }),
    ).toBe('id:9001');
  });
  it('falls back to the bank reference code', () => {
    expect(sepayDedupeKey({ ...base, bankReferenceCode: 'FT123' })).toBe(
      'ref:FT123',
    );
  });
  it('hashes account, time, amount and content when there is neither', () => {
    const key = sepayDedupeKey(base);
    expect(key).toMatch(/^h:[0-9a-f]{64}$/);
    // Cùng payload (SePay gọi lại) ra cùng khoá; đổi một trường ra khoá khác.
    expect(sepayDedupeKey({ ...base })).toBe(key);
    expect(sepayDedupeKey({ ...base, amount: 500001 })).not.toBe(key);
    expect(sepayDedupeKey({ ...base, content: 'khac' })).not.toBe(key);
    expect(sepayDedupeKey({ ...base, transactionDate: 'x' })).not.toBe(key);
  });
});

describe('sepayTransferFromPayload', () => {
  it('reads a SePay payload; a numeric id becomes a string and blank fields become null', () => {
    const transfer = sepayTransferFromPayload({
      id: 9001,
      referenceCode: '',
      accountNumber: '0123456789',
      transactionDate: '2026-11-11 10:00:00',
      content: 'ORD123456',
      transferAmount: 500000,
    });
    expect(transfer).toMatchObject({
      sepayTransactionId: '9001',
      bankReferenceCode: null,
      accountNumber: '0123456789',
      amount: 500000,
      dedupeKey: 'id:9001',
    });
  });
  it('a payload without any id is still keyed, and a replay gets the same key', () => {
    const payload = {
      accountNumber: '0123456789',
      transactionDate: '2026-11-11 10:00:00',
      content: 'chuyen tien',
      transferAmount: 1000,
    };
    const first = sepayTransferFromPayload(payload);
    expect(first.sepayTransactionId).toBeNull();
    expect(first.dedupeKey.startsWith('h:')).toBe(true);
    expect(sepayTransferFromPayload({ ...payload }).dedupeKey).toBe(
      first.dedupeKey,
    );
  });
  it('buildSepayTransfer agrees with the payload reader', () => {
    expect(
      buildSepayTransfer({ sepayTransactionId: 'TX', amount: 5 }).dedupeKey,
    ).toBe('id:TX');
  });
});
