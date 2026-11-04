import { OrderPriority } from '../../common/constants/order-status';

// Hằng số chỉ dùng cho đọc đơn (A-9). Đặt ở đây thay vì common/constants để task này không sửa file dùng chung; chuyển đi nếu module khác cần.

/** `stockCheck.status` của dòng (Đủ hàng / Thiếu một phần / Hết hàng): tính lúc đọc theo tồn trên kệ, không lưu; không phải số đã giữ cho đơn. `stockSummary` của đơn là dòng tệ nhất. */
export const StockCheckStatus = {
  ENOUGH: 'ENOUGH',
  PARTIAL: 'PARTIAL',
  OUT: 'OUT',
} as const;

export type StockCheckStatus =
  (typeof StockCheckStatus)[keyof typeof StockCheckStatus];

export const STOCK_CHECK_STATUSES: readonly string[] =
  Object.values(StockCheckStatus);

/** Xếp từ tệ nhất: `stockSummary` của đơn là giá trị đầu tiên trong danh sách này mà có dòng nào đó mang. */
export const STOCK_CHECK_SEVERITY: readonly StockCheckStatus[] = [
  StockCheckStatus.OUT,
  StockCheckStatus.PARTIAL,
  StockCheckStatus.ENOUGH,
];

/** `Payment.kind` (FULL | DEPOSIT | BALANCE | REFUND). BALANCE là khoản shipper thu khi giao; `collection` và `cashRemittanceStatus` đọc từ dòng này. */
export const PaymentKind = {
  FULL: 'FULL',
  DEPOSIT: 'DEPOSIT',
  BALANCE: 'BALANCE',
  REFUND: 'REFUND',
} as const;

export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

/** Các kiểu sắp xếp của `GET /orders`. Mỗi kiểu có một chiều cố định (mới nhất, giao sớm nhất, gấp nhất trước) vì đó là thứ màn hình cần. */
export const ORDER_SORTS = [
  'createdAt',
  'requestedDeliveryDate',
  'priority',
] as const;

export type OrderSort = (typeof ORDER_SORTS)[number];

/** Gấp nhất trước. `priority` là cột chuỗi nên DB sắp theo bảng chữ cái (HIGH < NORMAL < URGENT); danh sách duyệt lần lượt các nhóm này thay vì nhờ DB. */
export const PRIORITY_SORT_ORDER: readonly string[] = [
  OrderPriority.URGENT,
  OrderPriority.HIGH,
  OrderPriority.NORMAL,
];

/** Đơn bị gắn cờ "cần chú ý" ở bộ lọc `attention` và `GET /orders/alerts`: có dòng thiếu trên kệ, hoặc ngày giao khách sắp tới (hoặc đã qua). */
export const ORDER_ATTENTION_KINDS = [
  'SHORT',
  'DUE_SOON',
  'PICKUP_OVERDUE',
] as const;

export type OrderAttentionKind = (typeof ORDER_ATTENTION_KINDS)[number];

/** "Sắp tới ngày giao": ngày giao là hôm nay hoặc trong vòng ngần này ngày tính từ hôm nay. Ngày đã quá cũng tính: đó là trường hợp gấp nhất, không được miễn. */
export const DUE_SOON_DAYS = 2;
