import { parseBankAccountList, planSepayLinks } from './sepay-account-sync';
import { normalizeAccountNumber } from '../../common/utils/bank-account';

const LINKED_AT = new Date('2026-10-27T00:00:00Z');

describe('normalizeAccountNumber', () => {
  it('drops the grouping people type and upper-cases a VA', () => {
    expect(normalizeAccountNumber(' 0123 4567-8901 ')).toBe('012345678901');
    expect(normalizeAccountNumber('va.12ab')).toBe('VA12AB');
    expect(normalizeAccountNumber(null)).toBe('');
  });
});

describe('parseBankAccountList', () => {
  it('reads the documented list body', () => {
    expect(
      parseBankAccountList({
        status: 'success',
        data: [{ account_number: '012345678901', active: 1, label: 'x' }],
      }),
    ).toEqual([{ account_number: '012345678901', active: 1 }]);
  });

  it('refuses a body it does not understand rather than reading it as empty', () => {
    expect(parseBankAccountList({ status: 'error' })).toBeNull();
    expect(parseBankAccountList({ data: [{ number: '1' }] })).toBeNull();
    expect(parseBankAccountList('nope')).toBeNull();
  });
});

describe('planSepayLinks', () => {
  const tenants = [
    {
      id: 'new',
      bankingAccountNumber: '0123 4567 8901',
      bankingSepayLinkedAt: null,
    },
    {
      id: 'kept',
      bankingAccountNumber: '0123456789',
      bankingSepayLinkedAt: LINKED_AT,
    },
    {
      id: 'gone',
      bankingAccountNumber: '555',
      bankingSepayLinkedAt: LINKED_AT,
    },
    { id: 'none', bankingAccountNumber: null, bankingSepayLinkedAt: null },
  ];

  it('links on the edge, unlinks what SePay no longer watches, leaves the rest alone', () => {
    expect(
      planSepayLinks(tenants, [
        { account_number: '012345678901', active: true },
        { account_number: '0123456789' },
      ]),
    ).toEqual({ link: ['new'], unlink: ['gone'] });
  });

  it('treats a deactivated account as not watched', () => {
    expect(
      planSepayLinks(tenants, [
        { account_number: '012345678901', active: 0 },
        { account_number: '0123456789', active: '1' },
      ]),
    ).toEqual({ link: [], unlink: ['gone'] });
  });
});
