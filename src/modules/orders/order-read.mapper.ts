import { namedBranch } from '../../common/dto/location-ref.dto';
import {
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import { PaymentMethod } from '../../common/constants/payment-method';
import type { OrderDetailRow, OrderListRow } from './order-read';
import { summarizeStock, type StockCheck } from './stock-check';

// Rows -> the contract's OrderListItem / OrderDetail (A-9, contract §2). Every field POS already
// reads off these two routes (src/types/order.ts in the FE) is kept, under the same name and
// type: the order-journey fields are added beside them. Money leaves as numbers (contract §0).

type Decimalish = { toString(): string };

/** A Prisma Decimal as the number the API answers with. */
function num(value: Decimalish): number {
  return Number(value);
}

function numOrNull(value: Decimalish | null): number | null {
  return value === null ? null : Number(value);
}

/** A `@db.Date` column as the contract's plain `YYYY-MM-DD`. Postgres DATE comes back as UTC midnight, so the UTC date is the stored one. */
function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

interface UserRow {
  id: string;
  phoneNumber: string;
  profileFirstName: string | null;
  profileLastName: string | null;
}

export interface UserRef {
  id: string;
  name: string;
  phoneNumber: string;
}

/** The contract's `UserRef`. The name is put together the way the JWT strategy does; an account with no profile name shows its phone number. */
export function toUserRef(user: UserRow | null): UserRef | null {
  if (!user) return null;
  const name = user.profileFirstName
    ? `${user.profileFirstName} ${user.profileLastName ?? ''}`.trim()
    : user.phoneNumber;
  return { id: user.id, name, phoneNumber: user.phoneNumber };
}

/** `grandTotal − deposit`: what the shipper collects on delivery. Worked out, never stored (contract §6). */
export function amountDueOf(
  grandTotal: Decimalish,
  depositAmount: Decimalish | null,
): number {
  return Math.max(0, num(grandTotal) - (numOrNull(depositAmount) ?? 0));
}

/** `{ amount, percent }`; `percent` is null when the deposit was typed as an amount. */
export function depositOf(
  depositAmount: Decimalish | null,
  depositPercent: Decimalish | null,
): { amount: number; percent: number | null } | null {
  if (depositAmount === null) return null;
  return { amount: num(depositAmount), percent: numOrNull(depositPercent) };
}

/** Statuses an order only reaches after delivery - where a fully deposited order is shown as collected with nothing to collect. */
const DELIVERED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.RECEIVED,
  OrderStatus.COMPLETED,
  OrderStatus.RETURNED,
];

/**
 * `collection`: what was collected on delivery, from the order's BALANCE payment. Null until
 * delivery. A fully deposited order has no BALANCE row, so once it has shipped and been delivered
 * it reads `method: 'NONE'` with nothing collected.
 *
 * `method`: `Payment.method` for money a shipper took by QR is still open (contract §8 - SEPAY or
 * BANK_TRANSFER), so anything that is not cash is read as `BANK_TRANSFER_QR`.
 */
export function collectionOf(
  order: Pick<OrderListRow, 'status' | 'shippedAt' | 'payments'>,
  amountDue: number,
) {
  const balance = order.payments[0];
  if (balance) {
    return {
      method:
        balance.method === PaymentMethod.CASH ? 'CASH' : 'BANK_TRANSFER_QR',
      amount: num(balance.amount),
      collectedBy: toUserRef(balance.collectedBy),
      collectedAt: balance.paidAt ?? balance.createdAt,
      cashRemittanceStatus: balance.remittanceStatus,
      remittanceConfirmedBy: toUserRef(balance.remittanceConfirmedBy),
      remittanceConfirmedAt: balance.remittanceConfirmedAt,
    };
  }
  if (
    amountDue === 0 &&
    order.shippedAt !== null &&
    DELIVERED_ORDER_STATUSES.includes(order.status)
  ) {
    return {
      method: 'NONE',
      amount: 0,
      collectedBy: null,
      collectedAt: null,
      cashRemittanceStatus: RemittanceStatus.NOT_APPLICABLE,
      remittanceConfirmedBy: null,
      remittanceConfirmedAt: null,
    };
  }
  return null;
}

type ListLineRow = OrderListRow['items'][number];
type DetailLineRow = OrderDetailRow['items'][number];

/** One line as the list returns it: every column POS reads, money as numbers, plus `stockCheck`. */
function toLine(item: ListLineRow, stockChecks: Map<string, StockCheck>) {
  const {
    listUnitPrice,
    unitPrice,
    unitCostPrice,
    vatRate,
    discountAmount,
    lineTotal,
    ...rest
  } = item;
  return {
    ...rest,
    listUnitPrice: num(listUnitPrice),
    unitPrice: num(unitPrice),
    unitCostPrice: numOrNull(unitCostPrice),
    vatRate: numOrNull(vatRate),
    discountAmount: num(discountAmount),
    lineTotal: num(lineTotal),
    stockCheck: stockChecks.get(item.id) ?? null,
  };
}

function toCustomization(customization: DetailLineRow['customization']) {
  if (!customization) return null;
  return {
    lengthCm: numOrNull(customization.lengthCm),
    widthCm: numOrNull(customization.widthCm),
    heightCm: numOrNull(customization.heightCm),
    material: customization.material,
    color: customization.color,
    fabricCode: customization.fabricCode,
    note: customization.note,
    attachmentUrls: customization.attachmentUrls,
    specs: customization.specs.map(({ name, value, unit }) => ({
      name,
      value,
      unit,
    })),
  };
}

/** One line as the detail returns it: the list's line plus where it ships from and its custom specs. */
function toDetailLine(
  item: DetailLineRow,
  stockChecks: Map<string, StockCheck>,
) {
  const { sourceLocation, customization, ...rest } = item;
  return {
    ...toLine(rest, stockChecks),
    sourceLocation: sourceLocation
      ? { id: sourceLocation.id, name: sourceLocation.name }
      : null,
    customization: toCustomization(customization),
  };
}

/** The order-level fields both shapes share. `payments` and `items` are dropped here (`collection` and each shape's own lines replace them), and so is `channelPayload` - Shopee's raw order, kept only to re-sync it, not for any screen. */
function toOrderBase(row: OrderListRow) {
  const {
    branch,
    user,
    assignee,
    confirmedBy,
    shippedBy,
    payments: _payments,
    items: _items,
    appliedPromotions,
    subtotal,
    shippingFee,
    channelFee,
    vatTotal,
    grandTotal,
    depositAmount,
    depositPercent,
    discountValue,
    customerPay,
    change,
    requestedDeliveryDate,
    channelPayload: _channelPayload,
    ...rest
  } = row;

  const amountDue = amountDueOf(grandTotal, depositAmount);
  return {
    ...rest,
    branch: namedBranch(branch),
    // POS reads `user` as it always has; `createdBy` is the same person as the contract's UserRef.
    user,
    createdBy: toUserRef(user),
    assignee: toUserRef(assignee),
    confirmedBy: toUserRef(confirmedBy),
    shippedBy: toUserRef(shippedBy),
    subtotal: num(subtotal),
    shippingFee: num(shippingFee),
    channelFee: num(channelFee),
    vatTotal: num(vatTotal),
    grandTotal: num(grandTotal),
    discountValue: num(discountValue),
    customerPay: numOrNull(customerPay),
    change: numOrNull(change),
    deposit: depositOf(depositAmount, depositPercent),
    amountDue,
    collection: collectionOf(row, amountDue),
    requestedDeliveryDate: dateOnly(requestedDeliveryDate),
    appliedPromotions: appliedPromotions.map((promotion) => ({
      ...promotion,
      discountAmount: numOrNull(promotion.discountAmount),
    })),
  };
}

/**
 * The contract's `OrderListItem`, plus the lines: the contract drops them from the list, but POS's
 * invoice list expands an order's lines in place off this same response, so they stay.
 */
export function toOrderListItem(
  row: OrderListRow,
  stockChecks: Map<string, StockCheck>,
) {
  const items = row.items.map((item) => toLine(item, stockChecks));
  return {
    ...toOrderBase(row),
    items,
    // Top-level lines: a combo counts once, not once per component.
    itemCount: row.items.filter((item) => item.parentItemId === null).length,
    stockSummary: summarizeStock(items.map((item) => item.stockCheck)),
  };
}

/** The contract's `OrderDetail`. */
export function toOrderDetail(
  row: OrderDetailRow,
  stockChecks: Map<string, StockCheck>,
) {
  const { shipments, returns } = row;
  return {
    ...toOrderBase(row),
    items: row.items.map((item) => toDetailLine(item, stockChecks)),
    shipments: shipments.map(({ driver, ...shipment }) => ({
      ...shipment,
      driver: toUserRef(driver),
    })),
    returns,
  };
}
