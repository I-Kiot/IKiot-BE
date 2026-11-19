import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  OrderReturnChanges,
  returnTarget,
} from './order-returns.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: {} as PrismaService,
});

describe('order returns change template', () => {
  it('relates the order, the replacement order and the shipment', () => {
    expect(
      returnTarget(
        ctx(
          {
            id: 'r1',
            code: 'HT001',
            order: { id: 'o1', code: 'DH1' },
            replacementOrder: { id: 'o2', code: 'DH2' },
            shipmentId: 's1',
          },
          { id: 'r1' },
        ),
      ),
    ).toEqual({
      subjectId: 'r1',
      code: 'HT001',
      related: { orders: ['o1', 'o2'], shipments: ['s1'] },
    });
  });

  it('takes the id from the body when the route has none (confirm-failed-delivery)', () => {
    expect(
      returnTarget(
        ctx({
          id: 'r2',
          code: 'HT002',
          order: { id: 'o1' },
          replacementOrder: null,
        }),
      ),
    ).toMatchObject({ subjectId: 'r2', code: 'HT002' });
  });

  it('summaries with and without a code', () => {
    expect(
      OrderReturnChanges.inspected.summary({ actor: 'Mai', code: 'HT001' }),
    ).toBe('Mai vừa kiểm xong đơn hoàn HT001');
    expect(
      OrderReturnChanges.received.summary({ actor: 'Mai', code: null }),
    ).toBe('Mai vừa ghi nhận hàng hoàn của một đơn hoàn đã về');
  });
});
