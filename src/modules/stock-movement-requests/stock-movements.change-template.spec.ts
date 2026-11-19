import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  StockMovementChanges,
  movementLabel,
  movementTarget,
} from './stock-movements.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: {} as PrismaService,
});

describe('stock movements change template', () => {
  it('labels a movement like the FE: noun + last 6 id chars upper-cased', () => {
    expect(movementLabel('abc-123456789def', 'EXPORT')).toBe(
      'phiếu chuyển kho #789DEF',
    );
    expect(movementLabel('abc-123456789def', 'ADJUST')).toBe(
      'phiếu kiểm kê #789DEF',
    );
    expect(movementLabel('abc-123456789def', null)).toBe('phiếu kho #789DEF');
  });

  it('uses the route id and the movementType from the body', () => {
    expect(
      movementTarget(
        ctx({ id: 'x-0000aa', movementType: 'IMPORT' }, { id: 'x-0000aa' }),
      ),
    ).toEqual({ subjectId: 'x-0000aa', code: 'phiếu nhập hàng #0000AA' });
  });

  it('is defensive: no id at all gives a null subject', () => {
    expect(movementTarget(ctx({ success: true }))).toEqual({
      subjectId: null,
      code: null,
    });
  });

  it('summary reads naturally with and without a label', () => {
    expect(
      StockMovementChanges.shipped.summary({
        actor: 'Hà',
        code: 'phiếu chuyển kho #0000AA',
      }),
    ).toBe('Hà vừa xuất hàng phiếu chuyển kho #0000AA');
    expect(
      StockMovementChanges.closed.summary({ actor: 'Hà', code: null }),
    ).toBe('Hà vừa chốt một phiếu kho');
  });
});
