import { diffBanking } from './tenant-banking-history';

describe('diffBanking', () => {
  const base = {
    bankingAccountNumber: '111',
    bankingBankName: 'MB',
    bankingAccountName: 'SHOP',
    bankingSepayLinkedAt: null,
    bankingSepayWebhookApiKey: null,
  };

  it('returns nothing when nothing changed', () => {
    expect(diffBanking(base, { ...base })).toEqual({});
  });

  it('records old and new for plain fields', () => {
    expect(diffBanking(base, { ...base, bankingAccountNumber: '222' })).toEqual(
      { bankingAccountNumber: { from: '111', to: '222' } },
    );
  });

  it('never carries the webhook key, only that it changed', () => {
    const changes = diffBanking(base, {
      ...base,
      bankingSepayWebhookApiKey: 'super-secret',
    });
    expect(changes).toEqual({
      bankingSepayWebhookApiKey: { keyChanged: true },
    });
    expect(JSON.stringify(changes)).not.toContain('super-secret');
  });

  it('records a number change that clears the link and the key together', () => {
    const linked = new Date('2026-11-01T00:00:00.000Z');
    const changes = diffBanking(
      { ...base, bankingSepayLinkedAt: linked, bankingSepayWebhookApiKey: 'k' },
      {
        ...base,
        bankingAccountNumber: '222',
        bankingSepayLinkedAt: null,
        bankingSepayWebhookApiKey: null,
      },
    );
    expect(changes).toEqual({
      bankingAccountNumber: { from: '111', to: '222' },
      bankingSepayLinkedAt: { from: linked.toISOString(), to: null },
      bankingSepayWebhookApiKey: { keyChanged: true },
    });
  });
});
