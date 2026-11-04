import type { Prisma } from '../../../generated/prisma/client';

/** Mọi cột Tenant trừ `bankingSepayWebhookApiKey`: key là bí mật dùng chung để định danh shop với webhook thanh toán, ai có key có thể chốt đơn của shop. Prisma không có `select: false`, nên liệt kê cột an toàn thay vì loại trừ key; cột thêm sau này sẽ bị ẩn tới khi được thêm vào đây. */
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

/** Liên kết qua webhook key riêng của shop, hoặc qua việc sync thấy tài khoản trên SePay của nền tảng. Quy tắc đứng sau mọi `hasSepayKey`. */
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

/** Gom ba cột `banking*` phẳng thành object `banking` lồng. Chiều ghi vốn đã lồng; chiều đọc trả phẳng là lý do màn cài đặt đọc `tenant.banking.bankName` ra `undefined`. Cùng cách với `withNestedProfile` của nhân viên. */
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
