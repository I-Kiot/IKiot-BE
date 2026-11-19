import { buildEntityChanged } from '../../common/realtime/change-feed';
import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  OrderChanges,
  orderTarget,
  packTarget,
  shipTarget,
} from './orders.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
  prisma: unknown = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: prisma as PrismaService,
});

describe('orders change template', () => {
  it('reads the code from an OrderDetail body', () => {
    expect(orderTarget(ctx({ id: 'o1', code: 'DH1' }, { id: 'o1' }))).toEqual({
      subjectId: 'o1',
      code: 'DH1',
    });
  });

  it('reads the code from an { order } wrapper and falls back to the body id', () => {
    expect(
      orderTarget(ctx({ order: { id: 'o2', code: 'DH2' }, payment: {} })),
    ).toEqual({ subjectId: 'o2', code: 'DH2' });
  });

  it('ship lists the shipment from the shipment detail body', () => {
    const target = shipTarget(
      ctx({ id: 's1', order: { id: 'o1', code: 'DH1' } }, { id: 'o1' }),
    );
    expect(target).toMatchObject({ subjectId: 'o1', code: 'DH1' });
    expect(target.related?.shipments).toEqual(['s1']);
  });

  it('pack looks the order code up once and lists the fulfillment', async () => {
    const findFirst = jest.fn().mockResolvedValue({ code: 'DH3' });
    const target = await packTarget(
      ctx({ id: 'f1', orderId: 'o3' }, { id: 'o3' }, { order: { findFirst } }),
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'o3', tenantId: 'T1' },
      select: { code: true },
    });
    expect(target).toEqual({
      subjectId: 'o3',
      code: 'DH3',
      related: { fulfillments: ['f1'] },
    });
  });

  it('writes the summaries the user sees, with and without a code', () => {
    expect(
      OrderChanges.packed.summary({ actor: 'Nguyễn Văn A', code: 'DH0012' }),
    ).toBe('Nguyễn Văn A vừa đóng gói đơn DH0012');
    expect(OrderChanges.packed.summary({ actor: 'Lan', code: null })).toBe(
      'Lan vừa đóng gói một đơn',
    );
    expect(OrderChanges.qrPaid.summary({ actor: 'SePay', code: 'DH1' })).toBe(
      'Đơn DH1 vừa được khách thanh toán qua SePay',
    );
    expect(
      OrderChanges.qrExpiredCancelled.summary({ actor: 'x', code: null }),
    ).toBe('Một đơn đã tự huỷ vì mã QR hết hạn');
  });

  it('never puts money or customer data in a summary', () => {
    for (const spec of Object.values(OrderChanges)) {
      const text = spec.summary({ actor: 'A', code: 'DH1' });
      expect(text).not.toMatch(/\d{4,}|₫|đồng|khách hàng/);
    }
  });

  it('builds a quiet batch event for the QR expiry sweep', () => {
    const payload = buildEntityChanged({
      tenantId: 'T1',
      spec: OrderChanges.paymentQrExpired,
      target: {
        subjectId: null,
        code: null,
        related: { orders: ['o1', 'o2'] },
      },
      actor: { source: 'SYSTEM' },
    });
    expect(payload).toMatchObject({ quiet: true, subject: null });
    expect(payload.changes).toEqual([
      { resource: 'orders', ids: ['o1', 'o2'] },
    ]);
  });
});
