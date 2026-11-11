import {
  allocateProportional,
  sliceValue,
  toDong,
  type MoneyLike,
} from '../../common/utils/money';
import { OrderLineType } from '../../common/constants/order-status';

/**
 * Số học doanh thu của một đơn (thuần, không đọc DB). Phase 6 chỉ cần `netLineValues` cho gợi ý số hoàn khi kiểm hàng trả;
 * Phase 7 (nhật ký doanh thu, hoá đơn) dùng cùng hàm này, để hoá đơn, nhật ký và gợi ý hoàn tiền là MỘT quy tắc.
 */

export interface NetLineInput {
  id: string;
  lineType: string;
  lineTotal: MoneyLike;
}

export interface NetLineOrder {
  discountType: string | null;
  discountValue: MoneyLike;
}

/**
 * Giá trị thực của từng dòng sau giảm giá cả đơn: `lineTotal` (đã trừ giảm giá dòng / khuyến mãi) trừ phần giảm tay cả đơn (`discountType = ORDER`), chia theo tỉ lệ `lineTotal` giữa các dòng cấp trên bằng `allocateProportional` (các phần cộng lại đúng bằng số giảm).
 * Món trong combo (`COMBO_COMPONENT`) không có giá riêng: giá nằm ở dòng COMBO cha, nên chúng mang 0. Giá trị một dòng không âm.
 */
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

/**
 * Phần giá trị còn lại của mỗi dòng sau hàng đã trả, CÙNG quy tắc với hoá đơn và gợi ý hoàn tiền: giá trị thực của dòng (`netLineValues`) trừ phần của số đã trả (`sliceValue` luỹ kế).
 * Hàng trả trước khi đơn hoàn thành (trả một phần khi đang giao) nằm ở đây nên SALE ghi sau đó đã là số còn lại.
 */
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

/**
 * Số của bút toán SALE (ghi một lần khi đơn COMPLETED): hàng thực bán sau hàng đã trả, cộng phí ship thu của khách, giá vốn lấy từ sổ lô (`cogsByItem`, dương, đã ròng sau hàng trả về kho).
 * Σ `lines.amount` = `goods` và Σ `lines.cogs` = `cogs` (bất biến 8). Dòng hết số lượng không ghi.
 */
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

/**
 * Số của bút toán RETURN (âm): mỗi dòng trả lấy lát giá trị `sliceValue(net, số lượng dòng, đã trả trước lần này, số trả lần này)` nên các lần trả cộng lại đúng bằng giá trị dòng.
 * `items[].returnedQuantity` là số đã trả SAU lần này (kiểm hàng đã tăng nó); đơn quầy trả cả đơn truyền số trả = số còn lại. Phí ship không hoàn.
 * `returnCogsByItem`: giá vốn của đúng các dòng sổ RETURN_* của lần này, DƯƠNG (số hàng về × giá lô); bút toán ghi âm.
 */
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
