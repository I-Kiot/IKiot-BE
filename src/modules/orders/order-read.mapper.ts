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
import { derivePaymentStatus, paymentRowsOf } from './payment-status';
import type { OrderDetailRow, OrderListRow } from './order-read';
import { isPickupOverdue } from './order-pickup.rules';
import { summarizeStock, type StockCheck } from './stock-check';

// Dòng DB -> `OrderListItem` / `OrderDetail` của contract (A-9). Mọi trường POS đang đọc từ hai route này (src/types/order.ts bên FE)
// được giữ nguyên tên và kiểu; các trường hành trình được thêm bên cạnh. Tiền trả về là number (contract §0).

type Decimalish = { toString(): string };

function num(value: Decimalish): number {
  return Number(value);
}

function numOrNull(value: Decimalish | null): number | null {
  return value === null ? null : Number(value);
}

/** Cột `@db.Date` thành `YYYY-MM-DD`. Postgres trả DATE dưới dạng nửa đêm UTC nên lấy ngày UTC là ngày đã lưu. */
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

/** `UserRef` của contract. Tên đầy đủ đọc họ trước (`lastName firstName`, "Phạm Thị Lan") như màn hình nhân viên; tài khoản chưa có tên thì hiện số điện thoại. */
export function toUserRef(user: UserRow | null): UserRef | null {
  if (!user) return null;
  const name =
    [user.profileLastName, user.profileFirstName]
      .filter((part) => part && part.trim())
      .join(' ')
      .trim() || user.phoneNumber;
  return { id: user.id, name, phoneNumber: user.phoneNumber };
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

/**
 * `collection`: số đã thu khi giao (Payment BALANCE của đơn), null cho tới khi giao. Đơn cọc đủ không có dòng BALANCE nên sau giao là `method: 'NONE'`.
 *
 * `method`: `Payment.method` của khoản shipper thu QR (SEPAY hoặc BANK_TRANSFER, contract §8) chưa chốt, nên mọi khoản không tiền mặt đọc là `BANK_TRANSFER_QR`.
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

/** Một dòng trong danh sách: đủ mọi cột POS đọc, tiền là number, thêm `stockCheck`. */
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

/** Một dòng trong chi tiết: như dòng danh sách, thêm kho xuất và thông số may đo. */
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

/** Trường cấp đơn chung cho cả hai dạng. Bỏ `payments` và `items` (do từng dạng thay thế) và `channelPayload` (đơn Shopee gốc, chỉ để đồng bộ lại). */
function toOrderBase(row: OrderListRow) {
  const {
    branch,
    user,
    assignee,
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

/**
 * `OrderListItem` của contract cộng thêm các dòng: contract bỏ dòng khỏi danh sách, nhưng danh sách hóa đơn của POS
 * mở rộng dòng ngay tại chỗ từ cùng response này nên vẫn giữ.
 */
export function toOrderListItem(
  row: OrderListRow,
  stockChecks: Map<string, StockCheck>,
) {
  const items = row.items.map((item) => toLine(item, stockChecks));
  return {
    ...toOrderBase(row),
    items,
    // Tài xế của shipment mới nhất; null cho tới khi được gán.
    driver: toUserRef(row.shipments[0]?.driver ?? null),
    // Giao thất bại thì đơn vẫn ở SHIPPING (hàng còn ngoài kho); trường này để danh sách hiển thị điều đó.
    latestShipmentStatus: row.shipments[0]?.status ?? null,
    // Lần giao mới nhất, để ô chọn shipper ở danh sách gọi được `PATCH /shipments/:id/driver` (2026-11-08).
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

/**
 * `paymentSummary` của chi tiết đơn: mọi số từ MỘT quy tắc (`derivePaymentStatus`), nên khớp `orders.payment_status` và các route thu / hoàn.
 * `received` / `refunded` / `net` / `due` / `overpaidBy` là số nguyên đồng; `pendingRemittance` là tiền mặt shipper đã thu mà chủ chưa xác nhận nhận (đang ở tay shipper, chưa vào sổ thu chi).
 */
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
    /** Tiền shop đang giữ của đơn đã kết thúc mà chưa hoàn, chưa ghi thu nhập khác (`held-undecided.ts`). Quyết định bằng `POST /orders/:id/settle-held`. */
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
) {
  const { shipments, returns } = row;
  return {
    ...toOrderBase(row),
    paymentSummary: paymentSummaryOf(row, payments, journalTypes),
    items: row.items.map((item) => toDetailLine(item, stockChecks)),
    shipments: shipments.map(({ driver, ...shipment }) => ({
      ...shipment,
      driver: toUserRef(driver),
    })),
    returns,
    latestShipmentStatus: shipments.at(-1)?.status ?? null,
  };
}
