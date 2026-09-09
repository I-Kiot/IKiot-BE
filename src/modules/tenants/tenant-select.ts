import type { Prisma } from '../../../generated/prisma/client';

/** Every Tenant column except `bankingSepayWebhookApiKey`, which is a shared secret that identifies a tenant to the payment webhook - anyone holding one can settle that shop's orders. Prisma has no `select: false`, so the safe columns are listed instead of the secret: a column added later stays invisible until someone adds it here. Shared by `TenantService` and `TenantSelfService` so the two can't disagree. */
export const TENANT_SELECT = {
  id: true,
  name: true,
  tenantOwnerId: true,
  status: true,
  phoneNumber: true,
  mainAddress: true,
  taxNumber: true,
  bankingAccountNumber: true,
  bankingBankName: true,
  bankingAccountName: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

/** The flat banking columns, as the schema stores them. */
export interface FlatTenantBanking {
  bankingAccountNumber?: string | null;
  bankingBankName?: string | null;
  bankingAccountName?: string | null;
}

/** Swaps the three `banking*` columns for one nested `banking` object. The write side has always been nested, and the read side answering flat is why the settings screen read `tenant.banking.bankName` and got `undefined`. Same call `withNestedProfile` makes for a staff member. */
export function withNestedBanking<T extends FlatTenantBanking>(
  tenant: T,
): Omit<T, keyof FlatTenantBanking> & {
  banking: {
    accountNumber: string | null;
    bankName: string | null;
    accountName: string | null;
  };
} {
  const { bankingAccountNumber, bankingBankName, bankingAccountName, ...rest } =
    tenant;

  return {
    ...(rest as Omit<T, keyof FlatTenantBanking>),
    banking: {
      accountNumber: bankingAccountNumber ?? null,
      bankName: bankingBankName ?? null,
      accountName: bankingAccountName ?? null,
    },
  };
}
