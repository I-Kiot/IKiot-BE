import type { Prisma } from '../../../generated/prisma/client';
import { PriceChangeField } from '../../common/constants/price-change';
import { toDong, type MoneyLike } from '../../common/utils/money';

interface PriceBook {
  retailPrice?: MoneyLike;
  costPrice?: MoneyLike;
}

/** Hai trường giá mà lịch sử theo dõi, theo thứ tự ghi. */
const FIELDS = [
  { field: PriceChangeField.RETAIL_PRICE, key: 'retailPrice' },
  { field: PriceChangeField.COST_PRICE, key: 'costPrice' },
] as const;

/**
 * Các dòng lịch sử cho một lần đổi giá. `before` null = mặt hàng vừa tạo (from null, ghi cả hai giá). Trường vắng ở `after` hoặc không đổi (theo đồng) thì bỏ. Thuần, không đọc DB.
 */
export function priceChangeRows(
  before: PriceBook | null,
  after: PriceBook,
): { field: PriceChangeField; from: number | null; to: number }[] {
  const rows: { field: PriceChangeField; from: number | null; to: number }[] =
    [];
  for (const { field, key } of FIELDS) {
    if (after[key] === undefined || after[key] === null) continue;
    const to = toDong(after[key]);
    const from = before ? toDong(before[key]) : null;
    if (from !== to) rows.push({ field, from, to });
  }
  return rows;
}

/** Ghi lịch sử giá của một mặt hàng trong transaction của người gọi. `actorId` null = hệ thống (giá vốn combo tự tính lại). */
export async function recordPriceChange(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    productItemId: string;
    before: PriceBook | null;
    after: PriceBook;
    actorId: string | null;
  },
): Promise<void> {
  const rows = priceChangeRows(args.before, args.after);
  for (const row of rows) {
    await tx.productItemPriceChange.create({
      data: {
        tenantId: args.tenantId,
        productItemId: args.productItemId,
        field: row.field,
        fromValue: row.from,
        toValue: row.to,
        changedById: args.actorId,
      },
    });
  }
}
