import type { Prisma } from '../../../generated/prisma/client';

/** Select Tenant không có key webhook. */
export const TENANT_SELECT = {
  id: true,
  name: true,
  tenantOwnerId: true,
  status: true,
  phoneNumber: true,
  mainAddress: true,
  taxNumber: true,
  logoUrl: true,
  bankingAccountNumber: true,
  bankingBankName: true,
  bankingAccountName: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

/** Shop đã liên kết SePay chưa. */
export function isSepayLinked(tenant: {
  bankingSepayWebhookApiKey: string | null;
  bankingSepayLinkedAt: Date | null;
}): boolean {
  return Boolean(
    tenant.bankingSepayWebhookApiKey || tenant.bankingSepayLinkedAt,
  );
}

export interface FlatTenantBanking {
  bankingAccountNumber?: string | null;
  bankingBankName?: string | null;
  bankingAccountName?: string | null;
}

/** Gom cột `banking*` thành object `banking`. */
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
