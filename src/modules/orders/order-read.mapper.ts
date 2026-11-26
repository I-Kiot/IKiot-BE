import { heldUndecidedOf } from './held-undecided';
import { SalesJournalEntryType } from '../../common/constants/sales-journal';
import { namedBranch } from '../../common/dto/location-ref.dto';
import {
  OrderStatus,
  RemittanceStatus,
} from '../../common/constants/order-status';
import {
  PaymentKind,
  PaymentMethod,
  PaymentRecordStatus,
} from '../../common/constants/payment-method';
import { sumDong, toDong } from '../../common/utils/money';
import { personName } from '../../common/utils/user-profile';
import { derivePaymentStatus, paymentRowsOf } from './payment-status';
import type { OrderDetailRow, OrderListRow } from './order-read';
import { isPickupOverdue } from './order-pickup.rules';
import { summarizeStock, type StockCheck } from './stock-check';
import {
  NO_LINE_PRODUCTION,
  type OrderLineProduction,
} from '../production-requests/production-coverage';

/** YCSX còn mở theo id dòng đơn; dòng không có trong map là chưa đặt xưởng. */
export type LineProductionMap = ReadonlyMap<string, OrderLineProduction>;

// Đổi dữ liệu DB thành `OrderListItem` / `OrderDetail`.

type Decimalish = { toString(): string };

function num(value: Decimalish): number {
  return Number(value);
}

function numOrNull(value: Decimalish | null): number | null {
  return value === null ? null : Number(value);
}

/** Đổi cột Date thành `YYYY-MM-DD`. */
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

/** Tham chiếu người dùng: id và tên đầy đủ (họ trước). */
export function toUserRef(user: UserRow | null): UserRef | null {
  if (!user) return null;
  return {
    id: user.id,
    name: personName(user),
    phoneNumber: user.phoneNumber,
  };
}

/** `grandTotal − deposit`: số shipper thu khi giao. Tính lúc đọc, không lưu (contract §6). */
export function amountDueOf(
  grandTotal: Decimalish,
  depositAmount: Decimalish | null,
): number {
  return Math.max(0, num(grandTotal) - (numOrNull(depositAmount) ?? 0));
}

export function depositOf(
  depositAmount: Decimalish | null,
  depositPercent: Decimalish | null,
): { amount: number; percent: number | null } | null {
  if (depositAmount === null) return null;
  return { amount: num(depositAmount), percent: numOrNull(depositPercent) };
}

/** Các status chỉ đạt sau khi giao. Đơn đã cọc đủ được hiện là đã thu, không còn gì phải thu. */
const DELIVERED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.RECEIVED,
  OrderStatus.COMPLETED,
  OrderStatus.RETURNED,
];

/** Số đã thu khi giao, null tới khi giao. */
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

/** Một dòng hàng trong danh sách đơn. */
function toLine(
  item: ListLineRow,
  stockChecks: Map<string, StockCheck>,
  production: LineProductionMap,
) {
  const {
    listUnitPrice,
    unitPrice,
    unitCostPrice,
    vatRate,
    discountAmount,
    lineTotal,
    productItem,
    ...rest
  } = item;
  // Giữ dạng `productItem` cũ mà POS đang đọc.
  const { product, ...productItemRef } = productItem;
  return {
    ...rest,
    productItem: productItemRef,
    isManufacturable: product.isManufacturable,
    listUnitPrice: num(listUnitPrice),
    unitPrice: num(unitPrice),
    unitCostPrice: numOrNull(unitCostPrice),
    vatRate: numOrNull(vatRate),
    discountAmount: num(discountAmount),
    lineTotal: num(lineTotal),
    stockCheck: stockChecks.get(item.id) ?? null,
    // Hàng xưởng đang làm cho dòng này: màn hình trừ vào số thiếu khi gợi ý đặt xưởng.
    production: production.get(item.id) ?? NO_LINE_PRODUCTION,
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
    specs: customization.specs.map(
      ({ name, value, unit, attributeId, baseValue }) => ({
        name,
        value,
        unit,
        attributeId,
        baseValue,
      }),
    ),
  };
}

/** Một dòng hàng trong chi tiết đơn, thêm kho xuất và thông số may đo. */
function toDetailLine(
  item: DetailLineRow,
  stockChecks: Map<string, StockCheck>,
  production: LineProductionMap,
) {
  const { sourceLocation, customization, ...rest } = item;
  return {
    ...toLine(rest, stockChecks, production),
    sourceLocation: sourceLocation
      ? { id: sourceLocation.id, name: sourceLocation.name }
      : null,
    customization: toCustomization(customization),
  };
}

/** Trường cấp đơn chung cho danh sách và chi tiết. */
function toOrderBase(row: OrderListRow) {
  const {
    branch,
    user,
    assignee,
    seller,
    confirmedBy,
    shippedBy,
    payments: _payments,
    items: _items,
    shipments: _shipments,
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
    // POS vẫn đọc `user` như cũ; `createdBy` là cùng một người với `UserRef` của contract.
    user,
    createdBy: toUserRef(user),
    assignee: toUserRef(assignee),
    seller: toUserRef(seller),
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
    // Khách tới lấy đã quá ngày hẹn mà chưa tới: cờ để nhân viên liên hệ khách.
    pickupOverdue: isPickupOverdue(
      { ...rest, requestedDeliveryDate },
      new Date(),
    ),
    appliedPromotions: appliedPromotions.map((promotion) => ({
      ...promotion,
      discountAmount: numOrNull(promotion.discountAmount),
    })),
  };
}

/** Một đơn trong danh sách, kèm các dòng hàng. */
export function toOrderListItem(
  row: OrderListRow,
  stockChecks: Map<string, StockCheck>,
  production: LineProductionMap = new Map(),
) {
  const items = row.items.map((item) => toLine(item, stockChecks, production));
  return {
    ...toOrderBase(row),
    items,
    // Tài xế của shipment mới nhất; null cho tới khi được gán.
    driver: toUserRef(row.shipments[0]?.driver ?? null),
    // Giao thất bại thì đơn vẫn ở SHIPPING (hàng còn ngoài kho); trường này để danh sách hiển thị điều đó.
    latestShipmentStatus: row.shipments[0]?.status ?? null,
    // Lần giao mới nhất, cho ô chọn shipper ở danh sách.
    latestShipment: row.shipments[0]
      ? {
          id: row.shipments[0].id,
          status: row.shipments[0].status,
          carrierType: row.shipments[0].carrierType,
        }
      : null,
    // Chỉ tính dòng gốc: một combo tính một lần, không tính theo từng thành phần.
    itemCount: row.items.filter((item) => item.parentItemId === null).length,
    stockSummary: summarizeStock(items.map((item) => item.stockCheck)),
  };
}

/** Một khoản tiền của đơn như `paymentSummaryOf` cần. */
export interface SummaryPaymentRow {
  kind: string;
  status: string;
  amount: Decimalish;
  method: string;
  remittanceStatus: string;
}

/** Tóm tắt thanh toán của đơn, tính từ `derivePaymentStatus`. */
export function paymentSummaryOf(
  order: {
    status: string;
    grandTotal: Decimalish;
    depositAmount: Decimalish | null;
  },
  payments: readonly SummaryPaymentRow[],
  /** `entry_type` các bút toán doanh thu của đơn (quyết định "treo" của tiền giữ). */
  journalTypes: readonly string[],
) {
  const rows = payments.map((p) => ({
    kind: p.kind,
    status: p.status,
    amount: toDong(Number(p.amount)),
  }));
  const derived = derivePaymentStatus(
    toDong(Number(order.grandTotal)),
    paymentRowsOf({
      depositAmount: toDong(Number(order.depositAmount ?? 0)),
      payments: rows,
    }),
  );
  const pendingRemittance = sumDong(
    payments
      .filter(
        (p) =>
          p.kind === PaymentKind.BALANCE &&
          p.status === PaymentRecordStatus.PAID &&
          p.method === PaymentMethod.CASH &&
          p.remittanceStatus === RemittanceStatus.PENDING,
      )
      .map((p) => Number(p.amount)),
  );
  return {
    received: derived.received,
    refunded: derived.refunded,
    net: derived.net,
    due: derived.due,
    overpaidBy: derived.overpaidBy,
    pendingRemittance,
    /** Tiền treo của đơn đã kết thúc. */
    heldUndecided: heldUndecidedOf({
      status: order.status,
      hasSale: journalTypes.includes(SalesJournalEntryType.SALE),
      hasOtherIncome: journalTypes.includes(SalesJournalEntryType.OTHER_INCOME),
      net: derived.net,
    }),
  };
}

export function toOrderDetail(
  row: OrderDetailRow,
  stockChecks: Map<string, StockCheck>,
  payments: readonly SummaryPaymentRow[],
  journalTypes: readonly string[] = [],
  production: LineProductionMap = new Map(),
) {
  const { shipments, returns } = row;
  return {
    ...toOrderBase(row),
    paymentSummary: paymentSummaryOf(row, payments, journalTypes),
    items: row.items.map((item) => toDetailLine(item, stockChecks, production)),
    shipments: shipments.map(({ driver, ...shipment }) => ({
      ...shipment,
      driver: toUserRef(driver),
    })),
    returns,
    latestShipmentStatus: shipments.at(-1)?.status ?? null,
  };
}
