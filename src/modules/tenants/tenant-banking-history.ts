import type { Prisma } from '../../../generated/prisma/client';
import type { TenantBankingChangeSource } from '../../common/constants/tenant-banking-change';

/** Các cột nhận tiền của shop mà lịch sử theo dõi. `bankingSepayWebhookApiKey` là bí mật: chỉ được ghi dạng `{ keyChanged: true }`. */
export interface BankingState {
  bankingAccountNumber?: string | null;
  bankingBankName?: string | null;
  bankingAccountName?: string | null;
  bankingSepayLinkedAt?: Date | null;
  bankingSepayWebhookApiKey?: string | null;
}

export type BankingChanges = Record<
  string,
  { from: unknown; to: unknown } | { keyChanged: true }
>;

const PLAIN_FIELDS = [
  'bankingAccountNumber',
  'bankingBankName',
  'bankingAccountName',
] as const;

const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;

/** So hai ảnh chụp, chỉ giữ trường đổi. Thuần, không đọc DB; key webhook không bao giờ vào kết quả ngoài cờ `keyChanged`. Rỗng = không có gì để ghi. */
export function diffBanking(
  before: BankingState,
  after: BankingState,
): BankingChanges {
  const out: BankingChanges = {};
  for (const field of PLAIN_FIELDS) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) out[field] = { from, to };
  }
  const linkedFrom = iso(before.bankingSepayLinkedAt);
  const linkedTo = iso(after.bankingSepayLinkedAt);
  if (linkedFrom !== linkedTo) {
    out.bankingSepayLinkedAt = { from: linkedFrom, to: linkedTo };
  }
  if (
    (before.bankingSepayWebhookApiKey ?? null) !==
    (after.bankingSepayWebhookApiKey ?? null)
  ) {
    out.bankingSepayWebhookApiKey = { keyChanged: true };
  }
  return out;
}

/** Ghi một dòng lịch sử trong transaction của người gọi; không ghi gì khi không có thay đổi. */
export async function recordBankingChange(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    actorId: string | null;
    source: TenantBankingChangeSource;
    changes: BankingChanges;
  },
): Promise<void> {
  if (Object.keys(args.changes).length === 0) return;
  await tx.tenantBankingChange.create({
    data: {
      tenantId: args.tenantId,
      changedById: args.actorId,
      source: args.source,
      changes: args.changes as Prisma.InputJsonObject,
    },
  });
}
