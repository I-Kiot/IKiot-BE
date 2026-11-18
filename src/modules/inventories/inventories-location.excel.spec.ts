import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from './inventories.service';

const bodyOf = (error: unknown) =>
  (error as NotFoundException).getResponse() as {
    code: string;
    message: string;
  };

async function expectRejects(
  run: Promise<unknown>,
  type: new (...args: never[]) => Error,
  code: string,
  message?: string,
) {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(type);
  expect(bodyOf(caught).code).toBe(code);
  if (message) expect(bodyOf(caught).message).toBe(message);
}

// Excel sheet "Inventory" - updateMinStock, addProductToLocation, removeProductFromLocation (UTC018-UTC026).
describe('Excel sheet Inventory - location records', () => {
  let prisma: any;
  let service: InventoryService;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'INV1',
    tenantId: 'T1',
    productItemId: 'PI-01',
    branchId: 'BR-01',
    warehouseId: null,
    stock: 0,
    minStock: 10,
    productItem: { id: 'PI-01' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      inventory: {
        findFirst: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(row({ ...data }))),
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(row({ ...data }))),
        delete: jest.fn().mockResolvedValue({}),
      },
      productItem: { findFirst: jest.fn() },
    };
    service = new InventoryService(prisma, {} as never);
    jest
      .spyOn(service as any, 'assertLocationsExist')
      .mockResolvedValue(undefined);
  });

  describe('updateMinStock', () => {
    it('UTC018: sets the minimum stock of the inventory line', async () => {
      prisma.inventory.findFirst.mockResolvedValue(row());
      const res = await service.updateMinStock('T1', 'INV1', 20);
      expect(prisma.inventory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'INV1', tenantId: 'T1' } }),
      );
      expect(prisma.inventory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'INV1' },
          data: { minStock: 20 },
        }),
      );
      expect(res.minStock).toBe(20);
    });
    it('UTC019: zero is accepted (alerts are effectively off)', async () => {
      prisma.inventory.findFirst.mockResolvedValue(row());
      const res = await service.updateMinStock('T1', 'INV1', 0);
      expect(res.minStock).toBe(0);
    });
    it('UTC020: an inventory line of another tenant is not found', async () => {
      prisma.inventory.findFirst.mockResolvedValue(null);
      await expectRejects(
        service.updateMinStock('T1', 'missing', 5),
        NotFoundException,
        'INVENTORY_NOT_FOUND',
        'Inventory line not found',
      );
      expect(prisma.inventory.update).not.toHaveBeenCalled();
    });
  });

  describe('addProductToLocation', () => {
    const dto = {
      productItemId: 'PI-01',
      locationType: 'branch',
      locationId: 'BR-01',
    } as never;
    it('UTC021: creates an empty inventory line at the branch', async () => {
      prisma.productItem.findFirst.mockResolvedValue({ id: 'PI-01' });
      prisma.inventory.findFirst.mockResolvedValue(null);
      const res = await service.addProductToLocation('T1', dto);
      expect(prisma.inventory.create.mock.calls[0][0].data).toEqual({
        tenantId: 'T1',
        productItemId: 'PI-01',
        branchId: 'BR-01',
        warehouseId: null,
        stock: 0,
        minStock: 0,
      });
      expect(res.stock).toBe(0);
      expect(res.minStock).toBe(0);
    });
    it('UTC022: a product item that does not exist in the tenant', async () => {
      prisma.productItem.findFirst.mockResolvedValue(null);
      await expectRejects(
        service.addProductToLocation('T1', dto),
        NotFoundException,
        'PRODUCT_ITEM_NOT_FOUND',
        'Product item not found',
      );
      expect(prisma.inventory.create).not.toHaveBeenCalled();
    });
    it('UTC023: a product item already stocked at that location', async () => {
      prisma.productItem.findFirst.mockResolvedValue({ id: 'PI-01' });
      prisma.inventory.findFirst.mockResolvedValue({ id: 'INV1' });
      await expectRejects(
        service.addProductToLocation('T1', dto),
        ConflictException,
        'INVENTORY_ALREADY_AT_LOCATION',
        'This product item is already stocked at this location',
      );
      expect(prisma.inventory.create).not.toHaveBeenCalled();
    });
  });

  describe('removeProductFromLocation', () => {
    it('UTC024: a line with no stock is removed', async () => {
      prisma.inventory.findFirst.mockResolvedValue(row({ stock: 0 }));
      await expect(
        service.removeProductFromLocation('T1', 'INV1'),
      ).resolves.toEqual({
        success: true,
      });
      expect(prisma.inventory.delete).toHaveBeenCalledWith({
        where: { id: 'INV1' },
      });
    });
    it('UTC025: a line that still holds stock is kept', async () => {
      prisma.inventory.findFirst.mockResolvedValue(row({ stock: 5 }));
      await expectRejects(
        service.removeProductFromLocation('T1', 'INV1'),
        BadRequestException,
        'INVENTORY_STILL_HAS_STOCK',
        'Cannot remove this item from the location while 5 in stock remain. Transfer or sell them first.',
      );
      expect(prisma.inventory.delete).not.toHaveBeenCalled();
    });
    it('UTC026: even a single unit blocks the removal', async () => {
      prisma.inventory.findFirst.mockResolvedValue(row({ stock: 1 }));
      await expectRejects(
        service.removeProductFromLocation('T1', 'INV1'),
        BadRequestException,
        'INVENTORY_STILL_HAS_STOCK',
      );
    });
  });
});
