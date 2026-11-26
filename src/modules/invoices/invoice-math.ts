// Quy tắc nội dung hoá đơn, dạng hàm thuần.
import { toDong, type MoneyLike } from '../../common/utils/money';
import {
  keptLineValues,
  type NetLineOrder,
  type SaleItemInput,
} from '../orders/sales-math';

export interface InvoiceLineAmounts<T extends SaleItemInput> {
  line: T;
  /** Số lượng còn lại sau hàng trả trước khi xuất hoá đơn. */
  quantity: number;
  /** Giá trị thực của phần còn lại, SAU giảm giá cả đơn. */
  amount: number;
  /** Phần giảm giá cả đơn đã chia vào phần còn lại (chỉ để hiển thị: `amount` đã trừ rồi). */
  discount: number;
}

/** Dòng của hoá đơn bán, đã trừ hàng trả trước khi xuất. */
export function saleLines<T extends SaleItemInput>(
  order: NetLineOrder,
  lines: readonly T[],
): InvoiceLineAmounts<T>[] {
  const kept = keptLineValues(order, lines);
  return lines.flatMap((line) => {
    const k = kept.get(line.id)!;
    if (k.quantity <= 0) return [];
    return [
      {
        line,
        quantity: k.quantity,
        amount: k.amount,
        discount: Math.max(0, k.gross - k.amount),
      },
    ];
  });
}

/** Tổng hoá đơn bán = tổng dòng + phí ship. */
export function saleTotal(
  lines: readonly { amount: number }[],
  shippingFee: MoneyLike,
): number {
  return (
    lines.reduce((sum, l) => sum + l.amount, 0) +
    Math.max(0, toDong(shippingFee))
  );
}

export function nextInvoiceNumber(prefix: string, highest: number): string {
  return `${prefix}${String(highest + 1).padStart(6, '0')}`;
}
