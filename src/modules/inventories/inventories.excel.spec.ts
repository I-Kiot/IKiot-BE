import { BadRequestException } from '@nestjs/common';
import { InventoryService } from './inventories.service';
import { crossedLowStock } from './low-stock';

// Excel sheet "Inventory" - crossedLowStock, deductStock, adjustStock (UTC001-UTC017).
describe('crossedLowStock (Excel UTC001-UTC008)', () => {
  it('UTC001: null row', () => {
    expect(crossedLowStock(null, -5)).toBeNull();
  });
  it('UTC002: positive delta', () => {
    expect(crossedLowStock({ stock: 5, minStock: 10 }, 20)).toBeNull();
  });
  it('UTC003: zero delta', () => {
    expect(crossedLowStock({ stock: 8, minStock: 10 }, 0)).toBeNull();
  });
  it('UTC004: minStock 0 disables the alert', () => {
    expect(crossedLowStock({ stock: 5, minStock: 0 }, -3)).toBeNull();
  });
  it('UTC005: negative minStock', () => {
    expect(crossedLowStock({ stock: 5, minStock: -1 }, -3)).toBeNull();
  });
  it('UTC006: crossing below the threshold alerts', () => {
    const after = { stock: 9, minStock: 10 };
    expect(crossedLowStock(after, -3)).toBe(after);
  });
  it('UTC007: already below before the change does not re-alert', () => {
    expect(crossedLowStock({ stock: 3, minStock: 10 }, -2)).toBeNull();
  });
  it('UTC008: landing exactly on the threshold alerts', () => {
    const after = { stock: 10, minStock: 10 };
    expect(crossedLowStock(after, -3)).toBe(after);
  });
});

describe('InventoryService stock primitives (Excel UTC009-UTC017)', () => {
  let service: InventoryService;
  let tx: any;

  beforeEach(() => {
    service = new InventoryService({} as never, {} as never);
    tx = {
      inventory: {
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        findFirstOrThrow: jest.fn(),
        upsert: jest.fn().mockImplementation((a) => Promise.resolve(a)),
      },
    };
  });

  const deduct = (
    productItemId: string,
    quantity: number,
    label = productItemId,
  ) =>
    service.deductStock(tx, {
      tenantId: 'T1',
      productItemId,
      branchId: 'BR-01',
      warehouseId: null,
      quantity,
      label,
    });

  it.each([
    ['UTC009', 0],
    ['UTC010', -5],
  ])('%s: quantity %i is rejected', async (_id, qty) => {
    const p = deduct('PI-010', qty);
    await expect(p).rejects.toThrow(BadRequestException);
    await expect(p).rejects.toThrow(
      'The quantity to take out must be greater than 0',
    );
    expect(tx.inventory.updateMany).not.toHaveBeenCalled();
  });

  it('UTC011: stock below the quantity', async () => {
    tx.inventory.updateMany.mockResolvedValue({ count: 0 });
    tx.inventory.findFirst.mockResolvedValue({ stock: 5 });
    const p = deduct('PI-010', 10, 'AO-THUN-M-DEN');
    await expect(p).rejects.toThrow(BadRequestException);
    await expect(p).rejects.toThrow(
      'Not enough stock for AO-THUN-M-DEN: 10 needed, 5 left',
    );
  });

  it('UTC012: stock equal to the quantity leaves 0', async () => {
    tx.inventory.updateMany.mockResolvedValue({ count: 1 });
    tx.inventory.findFirstOrThrow.mockResolvedValue({ stock: 0 });
    const res = await deduct('PI-011', 10);
    expect(tx.inventory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stock: { gte: 10 } }),
        data: { stock: { decrement: 10 } },
      }),
    );
    expect(res.stock).toBe(0);
  });

  it('UTC013: stock above the quantity leaves the remainder', async () => {
    tx.inventory.updateMany.mockResolvedValue({ count: 1 });
    tx.inventory.findFirstOrThrow.mockResolvedValue({ stock: 7 });
    expect((await deduct('PI-012', 3)).stock).toBe(7);
  });

  it('UTC014: zero delta is a no-op', async () => {
    const res = await service.adjustStock(tx, {
      tenantId: 'T1',
      productItemId: 'PI-020',
      branchId: 'BR-01',
      warehouseId: null,
      delta: 0,
    });
    expect(res).toBeNull();
    expect(tx.inventory.upsert).not.toHaveBeenCalled();
  });

  it('UTC015: missing row is created with the delta', async () => {
    await service.adjustStock(tx, {
      tenantId: 'T1',
      productItemId: 'PI-021',
      branchId: 'BR-02',
      warehouseId: null,
      delta: 50,
    });
    expect(tx.inventory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ stock: 50 }),
      }),
    );
  });

  it('UTC016: no branch and no warehouse', async () => {
    const p = service.adjustStock(tx, {
      tenantId: 'T1',
      productItemId: 'PI-022',
      branchId: null,
      warehouseId: null,
      delta: 10,
    });
    await expect(p).rejects.toThrow(BadRequestException);
    await expect(p).rejects.toThrow(
      'A stock adjustment must name a branch or a warehouse',
    );
  });

  it('UTC017: warehouse adjustment decrements by 5', async () => {
    await service.adjustStock(tx, {
      tenantId: 'T1',
      productItemId: 'PI-023',
      branchId: null,
      warehouseId: 'WH-01',
      delta: -5,
    });
    expect(tx.inventory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_warehouseId_productItemId: {
            tenantId: 'T1',
            warehouseId: 'WH-01',
            productItemId: 'PI-023',
          },
        },
        update: { stock: { increment: -5 } },
      }),
    );
  });
});
