import { ProductionRequestStatus as S } from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  manualTransitionViolation,
  nextProductionRequestCode,
  statusAfterReceipt,
} from './production-request-rules';

describe('manualTransitionViolation', () => {
  it('lets a DRAFT be sent or cancelled', () => {
    expect(manualTransitionViolation(S.DRAFT, S.SENT, false)).toBeNull();
    expect(manualTransitionViolation(S.DRAFT, S.CANCELLED, false)).toBeNull();
  });

  it('lets a SENT request be cancelled while nothing has arrived', () => {
    expect(manualTransitionViolation(S.SENT, S.CANCELLED, false)).toBeNull();
  });

  it('refuses to cancel once goods have been received', () => {
    expect(
      manualTransitionViolation(S.PARTIALLY_RECEIVED, S.CANCELLED, true)?.code,
    ).toBe(ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS);
  });

  it('refuses to send twice', () => {
    expect(manualTransitionViolation(S.SENT, S.SENT, false)?.code).toBe(
      ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
    );
  });

  it('never moves a finished request', () => {
    for (const from of [S.COMPLETED, S.CANCELLED]) {
      expect(manualTransitionViolation(from, S.CANCELLED, false)?.code).toBe(
        ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
      );
    }
  });

  it('keeps the receipt-driven statuses out of reach', () => {
    for (const to of [S.PARTIALLY_RECEIVED, S.COMPLETED, S.DRAFT]) {
      expect(manualTransitionViolation(S.SENT, to, false)?.code).toBe(
        ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID,
      );
    }
  });
});

describe('closing short', () => {
  it('closes a partly received request when a reason is given', () => {
    expect(
      manualTransitionViolation(
        S.PARTIALLY_RECEIVED,
        S.COMPLETED,
        true,
        'Xưởng ngừng làm mẫu này',
      ),
    ).toBeNull();
  });

  it('insists on a reason', () => {
    for (const reason of [undefined, null, '', '   ']) {
      expect(
        manualTransitionViolation(
          S.PARTIALLY_RECEIVED,
          S.COMPLETED,
          true,
          reason,
        )?.code,
      ).toBe(ErrorCode.PRODUCTION_REQUEST_CLOSE_REASON_REQUIRED);
    }
  });

  it('is not a way round cancelling: nothing received means cancel', () => {
    for (const from of [S.DRAFT, S.SENT]) {
      expect(
        manualTransitionViolation(from, S.COMPLETED, false, 'lý do')?.code,
      ).toBe(ErrorCode.PRODUCTION_REQUEST_STATUS_INVALID);
    }
  });
});

describe('statusAfterReceipt', () => {
  it('is COMPLETED only when every line is fully received', () => {
    expect(
      statusAfterReceipt([
        { quantity: 2, receivedQuantity: 2 },
        { quantity: 1, receivedQuantity: 1 },
      ]),
    ).toBe(S.COMPLETED);
    expect(
      statusAfterReceipt([
        { quantity: 2, receivedQuantity: 2 },
        { quantity: 1, receivedQuantity: 0 },
      ]),
    ).toBe(S.PARTIALLY_RECEIVED);
  });
});

describe('nextProductionRequestCode', () => {
  it('starts at 1 and pads to six digits', () => {
    expect(nextProductionRequestCode(null)).toBe('YCSX000001');
  });

  it('follows the highest code', () => {
    expect(nextProductionRequestCode('YCSX000123')).toBe('YCSX000124');
    expect(nextProductionRequestCode('YCSX000123', 3)).toBe('YCSX000126');
  });

  it('ignores a code of another shape', () => {
    expect(nextProductionRequestCode('ABC')).toBe('YCSX000001');
  });
});
