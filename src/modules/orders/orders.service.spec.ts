import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InventoryService } from '../inventories/inventories.service';
import { OrderService } from './orders.service';

// Excel sheet "Orders" - create, priceLines, priceOrder, grandTotalOf (UTC001-UTC024).
describe('OrderService', () => {
  const TENANT = 'T1';
  // No view_all permission, so the actor is pinned to branch BR-01.
  const cashier = {
    userId: 'U1',
    branchId: 'BR-01',
    permissions: new Set(),
  } as never;
  const manager = { userId: 'U2', systemRole: 'TENANT_OWNER' } as never;

  const variants: Record<
    string,
    { id: string; sku: string; productName: string; retailPrice: number }
  > = {
    'PI-01': {
      id: 'PI-01',
      sku: 'SKU-01',
      productName: 'Ao',
      retailPrice: 100000,
    },
    'PI-02': {
      id: 'PI-02',
      sku: 'PI-02',
      productName: 'Quan',
      retailPrice: 50000,
    },
    'PI-03': {
      id: 'PI-03',
      sku: 'PI-03',
      productName: 'Non',
      retailPrice: 100000,
    },
    'PI-10': {
      id: 'PI-10',
      sku: 'PI-10',
      productName: 'A',
      retailPrice: 10000,
    },
    'PI-11': {
      id: 'PI-11',
      sku: 'PI-11',
      productName: 'B',
      retailPrice: 20000,
    },
  };

  let prisma: any;
  let tx: any;
  let inventory: any;
  let promotions: { calculate: jest.Mock };
  let sepay: any;
  let service: OrderService;
  let flows: jest.SpyInstance;

  const baseDto = (over: Record<string, unknown> = {}) => ({
    branchId: 'BR-01',
    customerId: 'CUS-1',
    paymentMethod: 'CASH',
    items: [{ productItemId: 'PI-01', quantity: 2, discountAmount: 1000 }],
    ...over,
  });

  beforeEach(() => {
    tx = {
      customer: { upsert: jest.fn().mockResolvedValue({ id: 'WALKIN' }) },
      order: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'O1',
            tenantId: TENANT,
            branchId: data.branchId,
            status: data.status,
            grandTotal: data.grandTotal,
            customerPay: data.customerPay ?? null,
            change: data.change,
            discountValue: data.discountValue,
            items: [],
            appliedPromotions: [],
          }),
        ),
      },
    };
    prisma = {
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 'BR-01' }) },
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'CUS-1' }) },
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          bankingBankName: 'VCB',
          bankingAccountNumber: '123',
          bankingAccountName: 'SHOP',
        }),
      },
      productItem: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(
              where.id.in
                .filter((id: string) => variants[id])
                .map((id: string) => variants[id]),
            ),
          ),
      },
      $transaction: jest.fn().mockImplementation((fn) => fn(tx)),
    };
    // The real deductStock: UTC011's message is produced by it.
    inventory = new InventoryService(prisma, {} as never);
    tx.inventory = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
      findFirstOrThrow: jest.fn().mockResolvedValue({ stock: 10 }),
    };
    jest.spyOn(inventory, 'notifyLowStock').mockResolvedValue(undefined);
    promotions = { calculate: jest.fn() };
    sepay = {
      generateOrderReference: jest.fn().mockReturnValue('REF'),
      buildQrUrl: jest.fn().mockReturnValue('qr://x'),
    };
    service = new OrderService(
      prisma,
      inventory,
      {} as never,
      {} as never,
      sepay,
      promotions as never,
    );
    flows = jest
      .spyOn(service as any, 'writeSaleCashFlows')
      .mockResolvedValue(undefined);
  });

  describe('create', () => {
    it('UTC001: branch-scoped user cannot create for another branch', async () => {
      const p = service.create(
        cashier,
        TENANT,
        baseDto({ branchId: 'BR-02' }) as never,
      );
      await expect(p).rejects.toThrow(ForbiddenException);
      await expect(p).rejects.toThrow(
        'You can only create orders for your own branch',
      );
    });

    it('UTC002: unknown branch', async () => {
      prisma.branch.findFirst.mockResolvedValue(null);
      const p = service.create(
        manager,
        TENANT,
        baseDto({ branchId: 'BR-99' }) as never,
      );
      await expect(p).rejects.toThrow(NotFoundException);
      await expect(p).rejects.toThrow('Branch not found');
    });

    it('UTC003: unknown customer', async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      const p = service.create(
        manager,
        TENANT,
        baseDto({ customerId: 'CUS-999' }) as never,
      );
      await expect(p).rejects.toThrow(NotFoundException);
      await expect(p).rejects.toThrow('Customer not found');
    });

    it('UTC004: SEPAY without bank account', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        bankingBankName: null,
        bankingAccountNumber: null,
      });
      const p = service.create(
        manager,
        TENANT,
        baseDto({ paymentMethod: 'SEPAY' }) as never,
      );
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'This shop has not configured its bank details for SePay payments',
      );
    });

    // PI-01: 2 x 100000 with a 1000 line discount => grandTotal 199000.
    it('UTC005: customerPay below grandTotal', async () => {
      const p = service.create(
        manager,
        TENANT,
        baseDto({ customerPay: 150000 }) as never,
      );
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'The customer paid 150000, which is less than the 199000 due',
      );
    });

    it('UTC006: customerPay equal to grandTotal gives change 0', async () => {
      const res = await service.create(
        manager,
        TENANT,
        baseDto({ customerPay: 199000 }) as never,
      );
      expect(res.order.change).toBe(0);
    });

    it('UTC007: customerPay above grandTotal gives change', async () => {
      const res = await service.create(
        manager,
        TENANT,
        baseDto({ customerPay: 200000 }) as never,
      );
      expect(res.order.change).toBe(1000);
    });

    it('UTC008: SEPAY without customerPay is PENDING with null change', async () => {
      const res = await service.create(
        manager,
        TENANT,
        baseDto({ paymentMethod: 'SEPAY' }) as never,
      );
      expect(res.order.status).toBe('PENDING');
      expect(res.order.change).toBeNull();
    });

    it('UTC009: CASH order is COMPLETED', async () => {
      const res = await service.create(manager, TENANT, baseDto() as never);
      expect(res.order.status).toBe('COMPLETED');
    });

    it('UTC010: SEPAY order is PENDING', async () => {
      const res = await service.create(
        manager,
        TENANT,
        baseDto({ paymentMethod: 'SEPAY' }) as never,
      );
      expect(res.order.status).toBe('PENDING');
    });

    it('UTC011: insufficient stock', async () => {
      tx.inventory.updateMany.mockResolvedValue({ count: 0 });
      tx.inventory.findFirst.mockResolvedValue({ stock: 2 });
      const dto = baseDto({ items: [{ productItemId: 'PI-02', quantity: 5 }] });
      const p = service.create(cashier, TENANT, dto as never);
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'Not enough stock for PI-02: 5 needed, 2 left',
      );
    });

    it('UTC012: CASH writes sale cash flows once', async () => {
      await service.create(manager, TENANT, baseDto() as never);
      expect(flows).toHaveBeenCalledTimes(1);
    });

    it('UTC013: SEPAY does not write cash flows', async () => {
      await service.create(
        manager,
        TENANT,
        baseDto({ paymentMethod: 'SEPAY' }) as never,
      );
      expect(flows).not.toHaveBeenCalled();
    });
  });

  describe('priceLines', () => {
    const price = (items: unknown[]) =>
      (service as any).priceLines(TENANT, { branchId: 'BR-01', items });

    it('UTC014: unknown product item', async () => {
      const p = price([{ productItemId: 'PI-INVALID', quantity: 1 }]);
      await expect(p).rejects.toThrow(NotFoundException);
      await expect(p).rejects.toThrow('Product item not found in this order');
    });

    it('UTC015: line discount above line total', async () => {
      const p = price([
        { productItemId: 'PI-03', quantity: 1, discountAmount: 100001 },
      ]);
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'A discount of 100001 exceeds the line total for PI-03 (100000)',
      );
    });

    it('UTC016: line discount equal to line total is valid', async () => {
      const lines = await price([
        { productItemId: 'PI-03', quantity: 1, discountAmount: 100000 },
      ]);
      expect(
        lines[0].unitPrice * lines[0].quantity - lines[0].discountAmount,
      ).toBe(0);
    });
  });

  describe('priceOrder', () => {
    const run = (dto: Record<string, unknown>) =>
      (service as any).priceOrder(TENANT, {
        branchId: 'BR-01',
        items: [{ productItemId: 'PI-01', quantity: 1 }],
        ...dto,
      });
    const msg = 'An order-level discount needs a discountValue greater than 0';

    it('UTC017: ORDER discount with value 0', async () => {
      const p = run({ discountType: 'ORDER', discountValue: 0 });
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(msg);
    });

    it('UTC018: ORDER discount with value omitted', async () => {
      const p = run({ discountType: 'ORDER' });
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(msg);
    });

    it('UTC019: promotion together with ORDER discount', async () => {
      const p = run({
        appliedPromotions: [{ promotionId: 'PROMO-01' }],
        discountType: 'ORDER',
        discountValue: 1000,
      });
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'An order cannot carry both an order-level discount and a promotion',
      );
    });

    it('UTC020: engine returns fewer breakdown entries than lines', async () => {
      promotions.calculate.mockResolvedValue({
        itemBreakdown: [{ discountAmount: 0 }],
        appliedPromotions: [],
        totalDiscount: 0,
      });
      const p = run({
        items: [
          { productItemId: 'PI-10', quantity: 1 },
          { productItemId: 'PI-11', quantity: 2 },
        ],
        appliedPromotions: [{ promotionId: 'PROMO-01' }],
      });
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow(
        'The discount could not be matched to the order lines',
      );
    });
  });

  describe('grandTotalOf', () => {
    const lines = [{ quantity: 2, unitPrice: 50000, discountAmount: 20000 }];
    const total = (type: string | null, value: number) =>
      (service as any).grandTotalOf(lines, type, value);

    it('UTC021: no order discount', () => {
      expect(total(null, 0)).toBe(80000);
    });
    it('UTC022: order discount is capped at the order value', () => {
      expect(total('ORDER', 200000)).toBe(0);
    });
    it('UTC023: negative order discount is treated as 0', () => {
      expect(total('ORDER', -50000)).toBe(80000);
    });
    it('UTC024: PROMOTION discount is not subtracted twice', () => {
      expect(total('PROMOTION', 15000)).toBe(80000);
    });
  });
});
