import { NotFoundException } from '@nestjs/common';
import { TenantSelfService } from './tenant-self.service';
import { TenantService } from './tenants.service';

const bodyOf = (error: unknown) =>
  (error as NotFoundException).getResponse() as {
    code: string;
    message: string;
  };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'T1',
  name: 'Cua hang A',
  tenantOwnerId: 'U1',
  status: 'ACTIVE',
  phoneNumber: '0912345678',
  mainAddress: null,
  taxNumber: null,
  bankingAccountNumber: '111',
  bankingBankName: 'ABC',
  bankingAccountName: 'A',
  bankingSepayWebhookApiKey: null,
  ...over,
});

// Excel sheet "Tenants" - TenantSelfService (UTC008-UTC019).
describe('Excel sheet Tenants - TenantSelfService', () => {
  let prisma: any;
  let notifications: {
    tenantOwners: jest.Mock;
    notify: jest.Mock;
    notifySystem: jest.Mock;
  };
  let service: TenantSelfService;

  beforeEach(() => {
    prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(row()),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(row({ ...data }))),
      },
    };
    notifications = {
      tenantOwners: jest.fn().mockResolvedValue(['O1', 'O2']),
      notify: jest.fn().mockResolvedValue({ notified: 2 }),
      notifySystem: jest.fn().mockResolvedValue({ notified: 1 }),
    };
    service = new TenantSelfService(prisma, notifications as never);
  });

  describe('findMine', () => {
    it('UTC008: shows hasSepayKey = true and never the key itself', async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        row({ bankingSepayWebhookApiKey: 'k' }),
      );
      const res = await service.findMine('T1');
      expect(res.hasSepayKey).toBe(true);
      expect(res).not.toHaveProperty('bankingSepayWebhookApiKey');
      expect(res.banking).toEqual({
        accountNumber: '111',
        bankName: 'ABC',
        accountName: 'A',
      });
    });
    it('UTC009: shows hasSepayKey = false without a key', async () => {
      expect((await service.findMine('T1')).hasSepayKey).toBe(false);
    });
    it('UTC010: an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      const run = service.findMine('missing');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) => {
        expect(bodyOf(error).code).toBe('TENANT_NOT_FOUND');
        expect(bodyOf(error).message).toBe('Shop not found');
      });
    });
  });

  describe('updateMine', () => {
    it('UTC011: updating plain fields sends no notification', async () => {
      await service.updateMine('T1', {
        name: 'Cua hang moi',
        phoneNumber: '0912345678',
      } as never);
      expect(prisma.tenant.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ name: 'Cua hang moi' }),
      );
      expect(prisma.tenant.update.mock.calls[0][0].data).not.toHaveProperty(
        'bankingAccountNumber',
      );
      expect(notifications.notifySystem).not.toHaveBeenCalled();
    });
    it('UTC012: a changed bank account notifies the operators', async () => {
      await service.updateMine('T1', {
        banking: { accountNumber: '222', bankName: 'ABC', accountName: 'A' },
      } as never);
      expect(prisma.tenant.update.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ bankingAccountNumber: '222' }),
      );
      expect(notifications.notifySystem).toHaveBeenCalledTimes(1);
      expect(notifications.notifySystem.mock.calls[0][0].type).toBe(
        'SYSTEM_TENANT_BANK_UPDATED',
      );
    });
    it('UTC013: an unchanged bank account sends nothing', async () => {
      await service.updateMine('T1', {
        banking: { accountNumber: '111', bankName: 'ABC', accountName: 'A' },
      } as never);
      expect(notifications.notifySystem).not.toHaveBeenCalled();
    });
    it('UTC014: an account without a bank name is not worth announcing', async () => {
      prisma.tenant.findUnique.mockResolvedValue(
        row({
          bankingAccountNumber: null,
          bankingBankName: null,
          bankingAccountName: null,
        }),
      );
      await service.updateMine('T1', {
        banking: { accountNumber: '222', bankName: null, accountName: 'A' },
      } as never);
      expect(prisma.tenant.update).toHaveBeenCalled();
      expect(notifications.notifySystem).not.toHaveBeenCalled();
    });
    it('UTC015: an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      const run = service.updateMine('missing', { name: 'x' } as never);
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) =>
        expect(bodyOf(error).code).toBe('TENANT_NOT_FOUND'),
      );
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });
  });

  describe('updateBanking', () => {
    it('UTC016: a new account notifies the operators', async () => {
      await service.updateBanking('T1', {
        accountNumber: '333',
        bankName: 'XYZ',
        accountName: 'B',
      } as never);
      expect(prisma.tenant.update.mock.calls[0][0].data).toEqual({
        bankingAccountNumber: '333',
        bankingBankName: 'XYZ',
        bankingAccountName: 'B',
      });
      expect(notifications.notifySystem).toHaveBeenCalledTimes(1);
    });
    it('UTC017: the same account again sends nothing', async () => {
      await service.updateBanking('T1', {
        accountNumber: '111',
        bankName: 'ABC',
        accountName: 'A',
      } as never);
      expect(notifications.notifySystem).not.toHaveBeenCalled();
    });
  });

  describe('setSepayKey', () => {
    it('UTC018: stores the key and tells every owner', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 'T1' });
      await expect(service.setSepayKey('T1', 'key-123')).resolves.toEqual({
        message: 'SePay key saved',
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'T1' },
        data: { bankingSepayWebhookApiKey: 'key-123' },
      });
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'T1',
          recipientIds: ['O1', 'O2'],
          referenceId: 'T1',
          type: 'SEPAY_LINKED',
        }),
      );
    });
    it('UTC019: an unknown tenant stores nothing', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      const run = service.setSepayKey('missing', 'key-123');
      await expect(run).rejects.toThrow(NotFoundException);
      await run.catch((error) =>
        expect(bodyOf(error).code).toBe('TENANT_NOT_FOUND'),
      );
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });
  });
});

// Excel sheet "Tenants" - findAll / create (UTC005-UTC007).
describe('Excel sheet Tenants - TenantService', () => {
  let prisma: any;
  let service: TenantService;
  beforeEach(() => {
    prisma = { tenant: { findMany: jest.fn(), create: jest.fn() } };
    service = new TenantService(prisma);
  });

  it('UTC005: lists tenants with hasSepayKey and without the key', async () => {
    prisma.tenant.findMany.mockResolvedValue([
      row({ id: 'T1', bankingSepayWebhookApiKey: 'k' }),
      row({ id: 'T2', bankingSepayWebhookApiKey: null }),
    ]);
    const res = await service.findAll();
    expect(res.map((t) => t.hasSepayKey)).toEqual([true, false]);
    res.forEach((t) =>
      expect(t).not.toHaveProperty('bankingSepayWebhookApiKey'),
    );
  });
  it('UTC006: no tenants gives an empty list', async () => {
    prisma.tenant.findMany.mockResolvedValue([]);
    await expect(service.findAll()).resolves.toEqual([]);
  });
  it('UTC007: creates a tenant and nests the banking fields', async () => {
    const { bankingSepayWebhookApiKey: _key, ...selected } = row({
      id: 'T3',
      name: 'Cua hang moi',
    });
    prisma.tenant.create.mockResolvedValue(selected);
    const res = await service.create({ name: 'Cua hang moi' } as never);
    expect(prisma.tenant.create.mock.calls[0][0].data).toEqual({
      name: 'Cua hang moi',
    });
    expect(res.id).toBe('T3');
    expect(res.banking).toBeDefined();
    expect(prisma.tenant.create.mock.calls[0][0].select).not.toHaveProperty(
      'bankingSepayWebhookApiKey',
    );
  });
});
