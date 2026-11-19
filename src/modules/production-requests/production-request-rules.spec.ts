import { ProductionRequestStatus as S } from '../../common/constants/production-request-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  manualTransitionViolation,
  nextProductionRequestCode,
  productionExcessOf,
  remainingNeedOf,
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

  const accepted = { acceptedByWorkshop: true, cancelledByWorkshop: false };
  const acceptedWorkshopCancels = {
    acceptedByWorkshop: true,
    cancelledByWorkshop: true,
  };

  it('refuses the shop cancelling a SENT request the workshop has accepted', () => {
    expect(
      manualTransitionViolation(S.SENT, S.CANCELLED, false, null, accepted)
        ?.code,
    ).toBe(ErrorCode.PRODUCTION_REQUEST_IN_PRODUCTION);
  });

  it('lets the workshop itself cancel a request it accepted', () => {
    expect(
      manualTransitionViolation(
        S.SENT,
        S.CANCELLED,
        false,
        'Hết gỗ',
        acceptedWorkshopCancels,
      ),
    ).toBeNull();
  });

  it('reports received goods first, whoever cancels', () => {
    for (const workshop of [accepted, acceptedWorkshopCancels]) {
      expect(
        manualTransitionViolation(
          S.PARTIALLY_RECEIVED,
          S.CANCELLED,
          true,
          null,
          workshop,
        )?.code,
      ).toBe(ErrorCode.PRODUCTION_REQUEST_HAS_RECEIPTS);
    }
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

describe('remainingNeedOf', () => {
  it('uses the whole line for custom goods and the shelf shortage otherwise', () => {
    expect(remainingNeedOf({ isCustom: true, quantity: 4 }, 0)).toBe(4);
    expect(remainingNeedOf({ isCustom: false, quantity: 4 }, 3)).toBe(3);
  });

  it('is unknown when a standard line has no stock check', () => {
    expect(remainingNeedOf({ isCustom: false, quantity: 4 }, null)).toBeNull();
  });
});

describe('productionExcessOf', () => {
  const line = (
    orderable: number | null,
    extra: Partial<{
      need: number | null;
      covered: number;
      poolKey: string;
      poolShort: number;
    }> = {},
  ) => ({
    need: 5,
    covered: 0,
    poolKey: 'pool-1',
    poolShort: 5,
    orderable,
    ...extra,
  });

  it('accepts exactly what is orderable', () => {
    expect(
      productionExcessOf(
        [{ orderItemId: 'L1', quantity: 5 }],
        new Map([['L1', line(5)]]),
      ),
    ).toBeNull();
  });

  it('refuses more than the line can still order', () => {
    expect(
      productionExcessOf(
        [{ orderItemId: 'L1', quantity: 3 }],
        new Map([['L1', line(2, { covered: 3 })]]),
      ),
    ).toEqual({
      orderItemId: 'L1',
      need: 5,
      alreadyOpen: 3,
      requested: 3,
      orderable: 2,
      scope: 'LINE',
    });
  });

  it('refuses two lines that fit alone but exceed the shared shortage', () => {
    const lines = new Map([
      ['L1', line(1, { poolShort: 1 })],
      ['L2', line(1, { poolShort: 1 })],
    ]);
    expect(
      productionExcessOf(
        [
          { orderItemId: 'L1', quantity: 1 },
          { orderItemId: 'L2', quantity: 1 },
        ],
        lines,
      ),
    ).toMatchObject({
      orderItemId: 'L1',
      requested: 2,
      orderable: 1,
      scope: 'POOL',
    });
  });

  it('sums repeated lines of the same order line', () => {
    expect(
      productionExcessOf(
        [
          { orderItemId: 'L1', quantity: 3 },
          { orderItemId: 'L1', quantity: 3 },
        ],
        new Map([['L1', line(5)]]),
      ),
    ).toMatchObject({ scope: 'LINE', requested: 6 });
  });

  it('ignores lines without an order line, unknown lines or a null orderable', () => {
    expect(
      productionExcessOf(
        [
          { orderItemId: null, quantity: 99 },
          { orderItemId: 'L2', quantity: 99 },
          { orderItemId: 'L3', quantity: 99 },
        ],
        new Map([['L3', line(null)]]),
      ),
    ).toBeNull();
  });
});
