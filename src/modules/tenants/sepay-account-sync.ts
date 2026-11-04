import { normalizeAccountNumber } from '../../common/utils/bank-account';

export interface SyncTenant {
  id: string;
  bankingAccountNumber: string | null;
  bankingSepayLinkedAt: Date | null;
}

/** The docs show `active` as both `1` and `true`. */
export interface SepayBankAccount {
  account_number: string;
  active?: number | boolean | string;
}

/** Null for anything that isn't a list of accounts: the sync must not read that as "no accounts". */
export function parseBankAccountList(body: unknown): SepayBankAccount[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const accounts: SepayBankAccount[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) return null;
    const { account_number: accountNumber, active } = row as Record<
      string,
      unknown
    >;
    if (typeof accountNumber !== 'string') return null;
    accounts.push({
      account_number: accountNumber,
      active: active as SepayBankAccount['active'],
    });
  }
  return accounts;
}

/** A missing `active` counts as active: not every sample in the docs has it. */
function isActive(account: SepayBankAccount): boolean {
  const { active } = account;
  return !(
    active === 0 ||
    active === false ||
    active === '0' ||
    active === 'false'
  );
}

/** Only shops whose state changes, so a periodic sync writes and notifies on the edge only. */
export function planSepayLinks(
  tenants: SyncTenant[],
  accounts: SepayBankAccount[],
): { link: string[]; unlink: string[] } {
  const watched = new Set(
    accounts
      .filter(isActive)
      .map((a) => normalizeAccountNumber(a.account_number)),
  );
  const link: string[] = [];
  const unlink: string[] = [];
  for (const tenant of tenants) {
    const number = normalizeAccountNumber(tenant.bankingAccountNumber);
    const onSepay = number !== '' && watched.has(number);
    if (onSepay && !tenant.bankingSepayLinkedAt) link.push(tenant.id);
    if (!onSepay && tenant.bankingSepayLinkedAt) unlink.push(tenant.id);
  }
  return { link, unlink };
}
