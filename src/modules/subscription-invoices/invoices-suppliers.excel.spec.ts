import { NotFoundException } from '@nestjs/common';
import { SubscriptionInvoiceService } from './subscription-invoices.service';
import { SupplierService } from '../suppliers/suppliers.service';

// Sheet Excel "SubscriptionInvoices" - listAll (UTC004-UTC005).
describe('Excel sheet SubscriptionInvoices - listAll', () => {
  let prisma: { subscriptionInvoice: { findMany: jest.Mock } };
  let service: SubscriptionInvoiceService;
  beforeEach(() => {
    prisma = { subscriptionInvoice: { findMany: jest.fn() } };
    service = new SubscriptionInvoiceService(prisma as never);
  });

  it('UTC004: returns every invoice, newest first, with plan and tenant details and no limit', async () => {
    prisma.subscriptionInvoice.findMany.mockResolvedValue([
      { id: 'I2' },
      { id: 'I1' },
    ]);
    await expect(service.listAll()).resolves.toEqual([
      { id: 'I2' },
      { id: 'I1' },
    ]);
    const args = prisma.subscriptionInvoice.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.include).toEqual({
      plan: { select: { planName: true, planCode: true } },
      tenant: { select: { name: true, phoneNumber: true } },
    });
    expect(args).not.toHaveProperty('take');
    expect(args).not.toHaveProperty('where');
  });
  it('UTC005: with no invoice it returns an empty list', async () => {
    prisma.subscriptionInvoice.findMany.mockResolvedValue([]);
    await expect(service.listAll()).resolves.toEqual([]);
  });
});

// Sheet Excel "Suppliers" - update (UTC015-UTC016).
describe('Excel sheet Suppliers - update', () => {
  let prisma: any;
  let service: SupplierService;
  beforeEach(() => {
    prisma = {
      supplier: { findFirst: jest.fn(), update: jest.fn() },
    };
    service = new SupplierService(prisma, {} as never);
  });

  it('UTC015: updates a supplier of the tenant', async () => {
    prisma.supplier.findFirst.mockResolvedValue({ id: 'SUP1' });
    prisma.supplier.update.mockResolvedValue({
      id: 'SUP1',
      name: 'Nha cung cap moi',
    });
    await expect(
      service.update('T1', 'SUP1', { name: 'Nha cung cap moi' } as never),
    ).resolves.toEqual({ id: 'SUP1', name: 'Nha cung cap moi' });
    expect(prisma.supplier.findFirst).toHaveBeenCalledWith({
      where: { id: 'SUP1', tenantId: 'T1' },
    });
    expect(prisma.supplier.update).toHaveBeenCalledWith({
      where: { id: 'SUP1' },
      data: { name: 'Nha cung cap moi' },
    });
  });
  it('UTC016: a supplier of another tenant is not found and nothing is updated', async () => {
    prisma.supplier.findFirst.mockResolvedValue(null);
    const run = service.update('T1', 'missing', { name: 'x' } as never);
    await expect(run).rejects.toThrow(NotFoundException);
    await run.catch((error) => {
      expect(error.getResponse().code).toBe('SUPPLIER_NOT_FOUND');
      expect(error.getResponse().message).toBe('Supplier not found');
    });
    expect(prisma.supplier.update).not.toHaveBeenCalled();
  });
});
