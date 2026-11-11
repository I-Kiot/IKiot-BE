import type { Prisma } from '../../../generated/prisma/client';
import {
  InventoryRefType,
  InventoryTxType,
} from '../../common/constants/inventory-ledger';
import { OrderStatus } from '../../common/constants/order-status';
import {
  SalesJournalEntryType,
  SalesJournalSource,
} from '../../common/constants/sales-journal';
import { ShipmentStatus } from '../../common/constants/shipment-status';
import { toDong } from '../../common/utils/money';
import { businessDate } from '../cash-drawer-sessions/business-date';
import {
  returnEntryAmounts,
  saleEntryAmounts,
  type EntryAmounts,
  type SaleItemInput,
} from './sales-math';

/**
 * Nhật ký doanh thu CHỈ GHI THÊM (`sales_journal_entries` + `_lines`, trigger chặn UPDATE). Hàm thường, nhận `tx` của người gọi (cùng kiểu `order-events.ts`); mọi lệnh ghi nằm trong transaction của việc gây ra nó nên rollback thì không còn bút toán nào.
 * Vì sao không tính lại từ `orders.completed_at`: đơn còn đổi sau khi hoàn thành (`returned_quantity` tăng, trạng thái RETURNED, hoá đơn điều chỉnh), tính lại sẽ làm đổi cả tháng đã chốt. Ở đây mỗi sự kiện ghi số có dấu của nó vào ngày nó xảy ra:
 * SALE vào ngày đơn COMPLETED, RETURN âm vào ngày trả hàng, OTHER_INCOME vào ngày shop giữ tiền. Kỳ cũ không bao giờ đổi.
 * Mọi chỗ chốt đơn COMPLETED phải gọi `postSale` sau lệnh chiếm (và sau khi hàng đã rời kho, vì giá vốn đọc từ sổ lô): `sales-journal.spec.ts` quét `src/` bắt cặp `completedData(` ↔ `postSale(`, và e2e `assertMoneyInvariants` kiểm "đơn COMPLETED có đúng một SALE".
 */

type Tx = Prisma.TransactionClient;

export interface JournalActor {
  /** Người bấm; null cho webhook / hệ thống. */
  id: string | null;
}

const SALE_LEDGER_TYPES = [
  InventoryTxType.SALE,
  InventoryTxType.SALE_REVERSAL,
  InventoryTxType.RETURN_GOOD,
  InventoryTxType.RETURN_DAMAGED,
];
const RETURN_LEDGER_TYPES = [
  InventoryTxType.RETURN_GOOD,
  InventoryTxType.RETURN_DAMAGED,
];

interface CogsRow {
  orderItemId: string;
  cogs: number;
}

/**
 * Giá vốn ròng của các dòng đơn từ SỔ LÔ (`inventory_transactions.unit_cost` = giá lô lúc hàng ra / về), không phải `costPrice` danh mục:
 * Σ(−số lượng × giá lô) trên SALE (số lượng âm → dương), SALE_REVERSAL / RETURN_* (số lượng dương → trừ lại). Dòng chưa xuất kho không có dòng sổ nên 0.
 */
async function netCogsByItem(
  tx: Tx,
  itemIds: readonly string[],
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<CogsRow[]>`
    SELECT order_item_id AS "orderItemId",
           COALESCE(SUM(-quantity * COALESCE(unit_cost, 0)), 0)::float8 AS cogs
    FROM inventory_transactions
    WHERE order_item_id = ANY(${[...itemIds]}::text[])
      AND type = ANY(${SALE_LEDGER_TYPES}::text[])
    GROUP BY order_item_id`;
  return new Map(rows.map((r) => [r.orderItemId, toDong(r.cogs)]));
}

/** Giá vốn của đúng các dòng sổ RETURN_* do MỘT chứng từ trả hàng ghi (đơn hoàn hoặc trả đơn quầy), dương. */
async function returnCogsByItem(
  tx: Tx,
  itemIds: readonly string[],
  ref: { referenceType: string; referenceId: string },
): Promise<Map<string, number>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<CogsRow[]>`
    SELECT order_item_id AS "orderItemId",
           COALESCE(SUM(quantity * COALESCE(unit_cost, 0)), 0)::float8 AS cogs
    FROM inventory_transactions
    WHERE order_item_id = ANY(${[...itemIds]}::text[])
      AND type = ANY(${RETURN_LEDGER_TYPES}::text[])
      AND reference_type = ${ref.referenceType}
      AND reference_id = ${ref.referenceId}
    GROUP BY order_item_id`;
  return new Map(rows.map((r) => [r.orderItemId, toDong(r.cogs)]));
}

const ORDER_FOR_JOURNAL = {
  id: true,
  tenantId: true,
  branchId: true,
  status: true,
  customerId: true,
  assigneeId: true,
  userId: true,
  channel: true,
  fulfillmentType: true,
  discountType: true,
  discountValue: true,
  shippingFee: true,
  channelFee: true,
  completedAt: true,
  items: {
    select: {
      id: true,
      lineType: true,
      productItemId: true,
      quantity: true,
      returnedQuantity: true,
      lineTotal: true,
    },
  },
} as const satisfies Prisma.OrderSelect;

type JournalOrder = Prisma.OrderGetPayload<{
  select: typeof ORDER_FOR_JOURNAL;
}>;

function loadOrder(tx: Tx, orderId: string) {
  return tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: ORDER_FOR_JOURNAL,
  });
}

function itemsOf(order: JournalOrder): SaleItemInput[] {
  return order.items.map((i) => ({
    id: i.id,
    lineType: i.lineType,
    productItemId: i.productItemId,
    quantity: i.quantity,
    returnedQuantity: i.returnedQuantity,
    lineTotal: i.lineTotal,
  }));
}

function snapshotOf(order: JournalOrder) {
  return {
    tenantId: order.tenantId,
    branchId: order.branchId,
    orderId: order.id,
    customerId: order.customerId,
    assigneeId: order.assigneeId,
    creatorId: order.userId,
    channel: order.channel,
    fulfillmentType: order.fulfillmentType,
  };
}

function linesOf(amounts: EntryAmounts) {
  return {
    create: amounts.lines.map((l) => ({
      orderItemId: l.orderItemId,
      productItemId: l.productItemId,
      quantity: l.quantity,
      amount: l.amount,
      cogs: l.cogs,
    })),
  };
}

/**
 * Bút toán SALE của một đơn vừa COMPLETED: hàng thực bán (sau hàng đã trả trước đó) với giá trị thực sau giảm giá cả đơn, phí ship thu của khách, giá vốn từ sổ lô,
 * và hai chi phí để báo cáo lợi nhuận (`shipping_cost` = Σ phí ĐVVC của các chuyến chưa huỷ, `channel_fee` = phí sàn). Ngày = ngày `now` (cùng mốc `completedAt`).
 * Gọi ngay sau lệnh chiếm COMPLETED, SAU khi hàng đã rời kho. Đã có SALE (gọi lại) thì không ghi gì và trả `null`.
 */
export async function postSale(
  tx: Tx,
  input: {
    orderId: string;
    actor: JournalActor;
    now: Date;
    source: SalesJournalSource;
  },
): Promise<{ id: string } | null> {
  const order = await loadOrder(tx, input.orderId);
  if (order.status !== OrderStatus.COMPLETED) return null;
  const existing = await tx.salesJournalEntry.findFirst({
    where: { orderId: order.id, entryType: SalesJournalEntryType.SALE },
    select: { id: true },
  });
  if (existing) return null;

  const items = itemsOf(order);
  const cogsByItem = await netCogsByItem(
    tx,
    items.map((i) => i.id),
  );
  const amounts = saleEntryAmounts({ order, items, cogsByItem });
  const shipments = await tx.shipment.aggregate({
    where: { orderId: order.id, status: { not: ShipmentStatus.CANCELLED } },
    _sum: { shippingCost: true },
  });

  return tx.salesJournalEntry.create({
    data: {
      ...snapshotOf(order),
      entryType: SalesJournalEntryType.SALE,
      businessDate: businessDate(input.now),
      goodsAmount: amounts.goods,
      shippingAmount: amounts.shipping,
      totalAmount: amounts.total,
      cogsAmount: amounts.cogs,
      shippingCost: toDong(shipments._sum.shippingCost),
      channelFee: toDong(order.channelFee),
      source: input.source,
      actorId: input.actor.id,
      lines: linesOf(amounts),
    },
    select: { id: true },
  });
}

/**
 * Bút toán RETURN (âm) cho hàng khách trả, ghi vào ngày trả. CHỈ khi đơn đã có SALE: trả trước khi hoàn thành thì SALE ghi sau đã trừ `returned_quantity`, và tiền shop giữ (nếu có) là OTHER_INCOME (`postOtherIncome`).
 * `orderReturnId` null = đơn quầy trả cả đơn (chỉ mục `sales_journal_one_pos_return`). Gọi SAU khi `returned_quantity` đã tăng và hàng đã về lô (giá vốn lấy từ các dòng sổ RETURN_* của chính chứng từ này).
 * Phí ship không hoàn. Trả `null` khi không có SALE hoặc không có dòng nào.
 */
export async function postReturn(
  tx: Tx,
  input: {
    orderId: string;
    orderReturnId: string | null;
    returning: readonly { orderItemId: string; quantity: number }[];
    /** Chứng từ ghi các dòng sổ RETURN_*: ORDER_RETURN + id đơn hoàn, hoặc ORDER + id đơn (đơn quầy). */
    ledgerRef: { referenceType: string; referenceId: string };
    actor: JournalActor;
    now: Date;
    source: SalesJournalSource;
  },
): Promise<{ id: string } | null> {
  const sale = await tx.salesJournalEntry.findFirst({
    where: {
      orderId: input.orderId,
      entryType: SalesJournalEntryType.SALE,
    },
    select: { id: true },
  });
  if (!sale) return null;
  const order = await loadOrder(tx, input.orderId);
  const returnCogs = await returnCogsByItem(
    tx,
    input.returning.map((r) => r.orderItemId),
    input.ledgerRef,
  );
  const amounts = returnEntryAmounts({
    order,
    items: itemsOf(order),
    returning: input.returning,
    returnCogsByItem: returnCogs,
  });
  if (amounts.lines.length === 0) return null;

  return tx.salesJournalEntry.create({
    data: {
      ...snapshotOf(order),
      orderReturnId: input.orderReturnId,
      entryType: SalesJournalEntryType.RETURN,
      businessDate: businessDate(input.now),
      goodsAmount: amounts.goods,
      shippingAmount: 0,
      totalAmount: amounts.total,
      cogsAmount: amounts.cogs,
      source: input.source,
      actorId: input.actor.id,
      lines: linesOf(amounts),
    },
    select: { id: true },
  });
}

/** Đơn quầy trả cả đơn: mọi dòng trả hết số còn lại. */
export function wholeOrderReturning(
  items: readonly { id: string; quantity: number; returnedQuantity: number }[],
): { orderItemId: string; quantity: number }[] {
  return items
    .filter((i) => i.quantity - i.returnedQuantity > 0)
    .map((i) => ({
      orderItemId: i.id,
      quantity: i.quantity - i.returnedQuantity,
    }));
}

/** Đơn quầy trả cả đơn: tra các dòng của đơn rồi `postReturn` với nguồn POS_RETURN. */
export async function postPosReturn(
  tx: Tx,
  input: { orderId: string; actor: JournalActor; now: Date },
) {
  const items = await tx.orderItem.findMany({
    where: { orderId: input.orderId },
    select: { id: true, quantity: true, returnedQuantity: true },
  });
  return postReturn(tx, {
    orderId: input.orderId,
    orderReturnId: null,
    returning: wholeOrderReturning(items),
    ledgerRef: {
      referenceType: InventoryRefType.ORDER,
      referenceId: input.orderId,
    },
    actor: input.actor,
    now: input.now,
    source: SalesJournalSource.POS_RETURN,
  });
}

/**
 * Bút toán OTHER_INCOME: tiền shop GIỮ của một đơn không thành (huỷ có giữ cọc, trả hàng trước khi hoàn thành mà không hoàn). Số = `kept` (> 0), ghi vào ngày giữ, một lần cho mỗi đơn.
 * Người gọi đã tính `kept` = tiền còn giữ SAU khi hoàn (derive.net). Đã có thì không ghi.
 */
export async function postOtherIncome(
  tx: Tx,
  input: {
    orderId: string;
    kept: number;
    actor: JournalActor;
    now: Date;
    source: SalesJournalSource;
  },
): Promise<{ id: string } | null> {
  const kept = toDong(input.kept);
  if (kept <= 0) return null;
  const existing = await tx.salesJournalEntry.findFirst({
    where: {
      orderId: input.orderId,
      entryType: SalesJournalEntryType.OTHER_INCOME,
    },
    select: { id: true },
  });
  if (existing) return null;
  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.orderId },
    select: ORDER_FOR_JOURNAL,
  });
  return tx.salesJournalEntry.create({
    data: {
      ...snapshotOf(order),
      entryType: SalesJournalEntryType.OTHER_INCOME,
      businessDate: businessDate(input.now),
      otherIncomeAmount: kept,
      totalAmount: kept,
      source: input.source,
      actorId: input.actor.id,
    },
    select: { id: true },
  });
}
