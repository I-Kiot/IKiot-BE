import type { ChangeExtractContext } from '../../common/realtime/change-feed.types';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  InventoryChanges,
  inventoryTarget,
} from './inventories.change-template';

const ctx = (
  body: unknown,
  params: Record<string, string> = {},
): ChangeExtractContext => ({
  body,
  params,
  tenantId: 'T1',
  prisma: {} as PrismaService,
});

describe('inventory change template', () => {
  it('names the line by its SKU, falling back to the product name', () => {
    expect(
      inventoryTarget(
        ctx(
          { id: 'inv-1', productItem: { sku: 'SOFA-L', productName: 'Sofa' } },
          { id: 'inv-1' },
        ),
      ),
    ).toEqual({ subjectId: 'inv-1', code: 'SOFA-L' });
    expect(
      inventoryTarget(
        ctx({ id: 'inv-2', productItem: { sku: null, productName: 'Sofa' } }),
      ),
    ).toEqual({ subjectId: 'inv-2', code: 'Sofa' });
  });

  it('is defensive about a body of the wrong shape', () => {
    expect(inventoryTarget(ctx({ success: true }))).toEqual({
      subjectId: null,
      code: null,
    });
  });

  it('says who did what to which SKU, with no quantity in it', () => {
    expect(
      InventoryChanges.markedDamaged.summary({ actor: 'An', code: 'SOFA-L' }),
    ).toBe('An vừa đánh dấu hỏng hàng SOFA-L');
    expect(
      InventoryChanges.writtenOff.summary({ actor: 'An', code: null }),
    ).toBe('An vừa huỷ hàng hỏng một mặt hàng');
  });
});
