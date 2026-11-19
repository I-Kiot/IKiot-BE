import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import { ShipmentChanges, shipmentTarget } from './shipments.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: {} as PrismaService,
});

describe('shipments change template', () => {
  it('takes the shipment id from the route and the order from the body', () => {
    expect(
      shipmentTarget(
        ctx(
          { id: 's1', order: { id: 'o1', code: 'DH1', status: 'X' } },
          { id: 's1' },
        ),
      ),
    ).toEqual({
      subjectId: 's1',
      code: 'DH1',
      related: { orders: ['o1'] },
    });
  });

  it('falls back to body.id on create (no :id)', () => {
    expect(
      shipmentTarget(ctx({ id: 's2', order: { id: 'o2', code: 'DH2' } }))
        .subjectId,
    ).toBe('s2');
  });

  it('is defensive about a body without an order', () => {
    expect(shipmentTarget(ctx({ id: 's3' }, { id: 's3' }))).toMatchObject({
      subjectId: 's3',
      code: null,
    });
  });

  it('summaries and quiet flag', () => {
    expect(
      ShipmentChanges.delivered.summary({ actor: 'Tuấn', code: 'DH1' }),
    ).toBe('Tuấn vừa giao thành công đơn DH1');
    expect(
      ShipmentChanges.delivered.summary({ actor: 'Tuấn', code: null }),
    ).toBe('Tuấn vừa giao thành công một đơn');
    expect(ShipmentChanges.qrReissued.quiet).toBe(true);
    expect(ShipmentChanges.delivered.quiet).toBe(false);
  });
});
