import {
  allocateProportional,
  sliceValue,
  toDong,
  type MoneyLike,
} from '../../common/utils/money';
import { OrderLineType } from '../../common/constants/order-status';

/** Số học doanh thu của một đơn. */

export interface NetLineInput {
  id: string;
  lineType: string;
  lineTotal: MoneyLike;
}

export interface NetLineOrder {
  discountType: string | null;
  discountValue: MoneyLike;
}

/** Giá trị thực của từng dòng sau khi chia giảm giá cả đơn. */
export function netLineValues(
  order: NetLineOrder,
  lines: readonly NetLineInput[],
): Map<string, number> {
  const top = lines.filter((l) => l.lineType !== OrderLineType.COMBO_COMPONENT);
  const totals = top.map((l) => Math.max(0, toDong(l.lineTotal)));
  const discount =
    order.discountType === 'ORDER'
      ? Math.min(
          toDong(order.discountValue),
          totals.reduce((a, b) => a + b, 0),
        )
      : 0;
  const cut = allocateProportional(discount, totals);
  const result = new Map<string, number>();
  for (const l of lines) result.set(l.id, 0);
  top.forEach((l, i) => result.set(l.id, totals[i] - cut[i]));
  return result;
}

/** Dòng đơn như nhật ký / hoá đơn cần: số lượng, thành tiền dòng, số đã trả. */
export interface SaleItemInput extends NetLineInput {
  productItemId: string;
  quantity: number;
  returnedQuantity: number;
}

export interface SaleLineAmounts {
  orderItemId: string;
  productItemId: string;
  /** Số lượng còn lại sau hàng trả (SALE) hoặc số lượng trả, âm (RETURN). */
  quantity: number;
  /** Giá trị thực sau giảm giá cả đơn, cùng dấu với `quantity`. Món combo con mang 0. */
  amount: number;
  /** Giá vốn, cùng dấu với `quantity`: dương ở SALE, âm ở RETURN. */
  cogs: number;
}

export interface EntryAmounts {
  goods: number;
  shipping: number;
  total: number;
  cogs: number;
  lines: SaleLineAmounts[];
}

/** Giá trị còn lại của mỗi dòng sau hàng đã trả. */
export function keptLineValues(
  order: NetLineOrder,
  items: readonly SaleItemInput[],
): Map<string, { quantity: number; amount: number; gross: number }> {
  const net = netLineValues(order, items);
  const out = new Map<
    string,
    { quantity: number; amount: number; gross: number }
  >();
  for (const item of items) {
    const lineNet = net.get(item.id) ?? 0;
    const returned = Math.min(item.quantity, item.returnedQuantity);
    out.set(item.id, {
      quantity: item.quantity - returned,
      amount: lineNet - sliceValue(lineNet, item.quantity, 0, returned),
      gross:
        Math.max(0, toDong(item.lineTotal)) -
        sliceValue(
          Math.max(0, toDong(item.lineTotal)),
          item.quantity,
          0,
          returned,
        ),
    });
  }
  return out;
}

/** Số liệu bút toán SALE. */
export function saleEntryAmounts(input: {
  order: NetLineOrder & { shippingFee: MoneyLike };
  items: readonly SaleItemInput[];
  cogsByItem: ReadonlyMap<string, number>;
}): EntryAmounts {
  const kept = keptLineValues(input.order, input.items);
  const lines: SaleLineAmounts[] = [];
  for (const item of input.items) {
    const k = kept.get(item.id)!;
    const cogs = input.cogsByItem.get(item.id) ?? 0;
    if (k.quantity <= 0 && cogs === 0) continue;
    lines.push({
      orderItemId: item.id,
      productItemId: item.productItemId,
      quantity: k.quantity,
      amount: k.amount,
      cogs,
    });
  }
  const goods = lines.reduce((s, l) => s + l.amount, 0);
  const shipping = Math.max(0, toDong(input.order.shippingFee));
  return {
    goods,
    shipping,
    total: goods + shipping,
    cogs: lines.reduce((s, l) => s + l.cogs, 0),
    lines,
  };
}

/** Số liệu bút toán RETURN. */
export function returnEntryAmounts(input: {
  order: NetLineOrder;
  items: readonly SaleItemInput[];
  returning: readonly { orderItemId: string; quantity: number }[];
  returnCogsByItem: ReadonlyMap<string, number>;
}): EntryAmounts {
  const net = netLineValues(input.order, input.items);
  const byId = new Map(input.items.map((i) => [i.id, i]));
  const lines: SaleLineAmounts[] = [];
  for (const r of input.returning) {
    const item = byId.get(r.orderItemId);
    if (!item || r.quantity <= 0) continue;
    const already = Math.max(0, item.returnedQuantity - r.quantity);
    const value = sliceValue(
      net.get(item.id) ?? 0,
      item.quantity,
      already,
      r.quantity,
    );
    lines.push({
      orderItemId: item.id,
      productItemId: item.productItemId,
      quantity: -r.quantity,
      amount: -value,
      cogs: -(input.returnCogsByItem.get(item.id) ?? 0),
    });
  }
  const goods = lines.reduce((s, l) => s + l.amount, 0);
  return {
    goods,
    shipping: 0,
    total: goods,
    cogs: lines.reduce((s, l) => s + l.cogs, 0),
    lines,
  };
}
