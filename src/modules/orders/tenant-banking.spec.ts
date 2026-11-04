import { ErrorCode } from '../../common/errors/error-codes';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  buildSepayQrUrl,
  requireTenantBanking,
  transferContent,
} from './tenant-banking';

describe('requireTenantBanking', () => {
  const account = {
    bankingBankName: 'TPBank',
    bankingAccountNumber: '0123456789',
    bankingAccountName: 'NOI THAT DEMO',
  };
  const prismaWith = (row: Record<string, unknown> | null) =>
    ({
      tenant: { findUnique: jest.fn().mockResolvedValue(row) },
    }) as unknown as Pick<PrismaService, 'tenant'>;
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'no error',
      (error: { getResponse(): { code: string } }) => error.getResponse().code,
    );

  it('refuses a shop with no receiving account', async () => {
    const prisma = prismaWith({
      bankingBankName: null,
      bankingAccountNumber: null,
      bankingAccountName: null,
      bankingSepayWebhookApiKey: null,
      bankingSepayLinkedAt: new Date(),
    });
    expect(await codeOf(requireTenantBanking(prisma, 't'))).toBe(
      ErrorCode.TENANT_BANKING_NOT_CONFIGURED,
    );
  });

  it('refuses an account SePay is not watching', async () => {
    const prisma = prismaWith({
      ...account,
      bankingSepayWebhookApiKey: null,
      bankingSepayLinkedAt: null,
    });
    expect(await codeOf(requireTenantBanking(prisma, 't'))).toBe(
      ErrorCode.TENANT_SEPAY_NOT_LINKED,
    );
  });

  it('accepts either way of being linked, and never hands the webhook key on', async () => {
    for (const link of [
      { bankingSepayWebhookApiKey: null, bankingSepayLinkedAt: new Date() },
      { bankingSepayWebhookApiKey: 'per-shop-key', bankingSepayLinkedAt: null },
    ]) {
      const prisma = prismaWith({ ...account, ...link });
      await expect(requireTenantBanking(prisma, 't')).resolves.toEqual(account);
    }
  });
});

describe('transferContent', () => {
  it('puts SEVQR in front of the reference for VietinBank, however it is spelled', () => {
    for (const name of ['VietinBank', 'vietin bank', 'ICB', 'CTG', '970415']) {
      expect(transferContent(name, 'ORD1A2B3C4D5E')).toBe(
        'SEVQR ORD1A2B3C4D5E',
      );
    }
  });

  it('leaves every other bank with the bare reference', () => {
    expect(transferContent('MB', 'ORD1A2B3C4D5E')).toBe('ORD1A2B3C4D5E');
    expect(transferContent(null, 'ORD1A2B3C4D5E')).toBe('ORD1A2B3C4D5E');
  });
});

describe('buildSepayQrUrl', () => {
  it('carries the bank-specific content in addInfo', () => {
    const url = buildSepayQrUrl(
      {
        bankingBankName: 'VietinBank',
        bankingAccountNumber: '0123456789',
        bankingAccountName: 'NOI THAT DEMO',
      },
      150000,
      'ORD1A2B3C4D5E',
    );
    expect(url).toContain('/VietinBank-0123456789-compact2.png');
    expect(url).toContain('addInfo=SEVQR%20ORD1A2B3C4D5E');
  });
});
