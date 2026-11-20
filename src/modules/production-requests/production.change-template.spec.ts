import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  ProductionChanges,
  deliveryReceiveTarget,
  deliveryTarget,
  productionRequestTarget,
} from './production.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: {} as PrismaService,
});

const request = {
  id: 'r1',
  code: 'YC001',
  items: [
    { orderItem: { orderId: 'o1' } },
    { orderItem: null },
    { orderItem: { orderId: 'o2' } },
  ],
};

describe('production change template', () => {
  it('lists the orders behind a request through items[].orderItem.orderId', () => {
    expect(productionRequestTarget(ctx(request, { id: 'r1' }))).toEqual({
      subjectId: 'r1',
      code: 'YC001',
      related: { orders: ['o1', 'o2'], 'stock-movements': [null] },
    });
  });

  it('adds the stock movement on a receipt', () => {
    const target = productionRequestTarget(
      ctx({ ...request, stockMovementId: 'm1' }, { id: 'r1' }),
    );
    expect(target.related?.['stock-movements']).toEqual(['m1']);
  });

  it('uses the route id for a delete whose body is { success: true }', () => {
    expect(
      productionRequestTarget(ctx({ success: true }, { id: 'r9' })),
    ).toMatchObject({ subjectId: 'r9', code: null });
  });

  it('delivery subject is the note; the request and its orders are related', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { orderItem: { orderId: 'o1' } },
        { orderItem: { orderId: 'o1' } },
      ]);
    const target = await deliveryTarget({
      ...ctx(
        {
          id: 'd1',
          code: 'PGX1',
          productionRequest: { id: 'r1', code: 'YC001' },
        },
        { id: 'd1' },
      ),
      prisma: {
        productionRequestItem: { findMany },
      } as unknown as PrismaService,
    });
    expect(target).toEqual({
      subjectId: 'd1',
      code: 'PGX1',
      related: { 'production-requests': ['r1'], orders: ['o1', 'o1'] },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('delivery without a request in the body does not query', async () => {
    const findMany = jest.fn();
    const target = await deliveryTarget({
      ...ctx({ id: 'd1', code: 'PGX1' }, { id: 'd1' }),
      prisma: {
        productionRequestItem: { findMany },
      } as unknown as PrismaService,
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(target.subjectId).toBe('d1');
  });

  it('receiving a delivery names the request code and relates everything touched', () => {
    const target = deliveryReceiveTarget(
      ctx({ ...request, stockMovementId: 'm1' }, { id: 'd1' }),
    );
    expect(target).toEqual({
      subjectId: 'd1',
      code: 'YC001',
      related: {
        'production-requests': ['r1'],
        orders: ['o1', 'o2'],
        'stock-movements': ['m1'],
      },
    });
  });

  it('summaries', () => {
    expect(
      ProductionChanges.accepted.summary({ actor: 'Xưởng A', code: 'YC001' }),
    ).toBe('Xưởng A vừa nhận làm yêu cầu sản xuất YC001');
    expect(
      ProductionChanges.deleted.summary({ actor: 'Lan', code: null }),
    ).toBe('Lan vừa xoá một yêu cầu sản xuất');
    expect(
      ProductionChanges.deliveryRejected.summary({
        actor: 'Lan',
        code: 'PGX1',
      }),
    ).toBe('Lan vừa từ chối phiếu giao PGX1');
  });
});
