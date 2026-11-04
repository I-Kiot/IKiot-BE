/**
 * Hành trình đơn: PENDING_CONFIRMATION (Shopee) → CONFIRMED → PACKED → PICKED_UP → SHIPPING → RECEIVED → COMPLETED. Mọi đổi trạng thái đi qua `assertTransition`.
 * Mục @deprecated là thiết kế giữ hàng đã bỏ, giữ tới khi track A, C viết lại (migration 20261004120000 chặn khi còn đơn ở trạng thái này).
 */
export const OrderStatus = {
  /** Đơn marketplace vừa đồng bộ, chờ nhân viên xác nhận và gán người phụ trách. */
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  /** Đã xác nhận có người phụ trách; đơn thủ công được tạo ở trạng thái này. Chưa đụng tới kho. */
  CONFIRMED: 'CONFIRMED',
  /** Đã đóng gói, chờ shipper/đơn vị vận chuyển. Hàng bị khoá khỏi kệ (`lockStock`), vẫn nằm trong `stock`. */
  PACKED: 'PACKED',
  /** Shipper/đơn vị vận chuyển đã nhận hàng. Vẫn khoá, vẫn trong `stock`. */
  PICKED_UP: 'PICKED_UP',
  /** Người có orders:ship xác nhận đang giao - hàng khoá rời `stock` tại đây (`shipLockedStock`). */
  SHIPPING: 'SHIPPING',
  /** Đã giao và shipper đã thu tiền mặt; chờ chủ shop xác nhận tiền về đủ. */
  RECEIVED: 'RECEIVED',
  /** Đã giao và thanh toán đủ; với tiền mặt là đã nộp về shop. */
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  /** Mọi dòng đã được trả lại. */
  RETURNED: 'RETURNED',
  /**
   * Legacy: trạng thái chờ chuyển khoản SePay của máy bán hàng. OrdersService vẫn mở đơn SePay ở đây tới khi track A (A-2) chuyển sang trạng thái mới và migrate dữ liệu; sau đó bỏ mục này.
   */
  PENDING: 'PENDING',
  /** @deprecated Thiết kế giữ hàng - không còn ai tạo (hợp đồng §7). */
  DRAFT: 'DRAFT',
  /** @deprecated Thiết kế giữ hàng - không còn ai tạo (hợp đồng §7). */
  READY_TO_PACK: 'READY_TO_PACK',
  /** @deprecated Thay bằng RECEIVED (hợp đồng §7). */
  DELIVERED: 'DELIVERED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUSES: readonly string[] = Object.values(OrderStatus);

/** Các trạng thái chưa cần người phụ trách; mọi trạng thái khác bị ràng buộc bởi CHECK `orders_assignee_required`. */
export const UNASSIGNED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.PENDING_CONFIRMATION,
];

/** Đơn còn chờ rời kho: các dòng là nhu cầu cho danh sách sản xuất và stockCheck, và còn sửa được. */
export const UNSHIPPED_ORDER_STATUSES: readonly string[] = [
  OrderStatus.CONFIRMED,
  OrderStatus.PACKED,
  OrderStatus.PICKED_UP,
];

/** Không trạng thái nào đưa đơn ra khỏi nhóm này. */
export const FINAL_ORDER_STATUSES: readonly string[] = [
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
];

/** Tiến độ của từng dòng đơn. Hàng có đủ hay không được hiển thị qua stockCheck, không lưu. */
export const OrderItemStatus = {
  PENDING: 'PENDING',
  /** Kho đã bị trừ khi đơn chuyển sang SHIPPING. */
  SHIPPED: 'SHIPPED',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
  /** @deprecated Thiết kế giữ hàng (hợp đồng §7). */
  WAITING_STOCK: 'WAITING_STOCK',
  /** @deprecated Thiết kế giữ hàng (hợp đồng §7). */
  READY: 'READY',
  /** @deprecated Thiết kế giữ hàng (hợp đồng §7) - đã chuyển sang SHIPPED. */
  PACKED: 'PACKED',
  /** @deprecated Đã chuyển sang SHIPPED. */
  DELIVERED: 'DELIVERED',
} as const;

export type OrderItemStatus =
  (typeof OrderItemStatus)[keyof typeof OrderItemStatus];

export const ORDER_ITEM_STATUSES: readonly string[] =
  Object.values(OrderItemStatus);

/** Loại dòng. Dòng COMBO chỉ mang giá; các dòng COMBO_COMPONENT con mang hàng với giá 0. */
export const OrderLineType = {
  PRODUCT: 'PRODUCT',
  COMBO: 'COMBO',
  COMBO_COMPONENT: 'COMBO_COMPONENT',
  SERVICE: 'SERVICE',
} as const;

export type OrderLineType = (typeof OrderLineType)[keyof typeof OrderLineType];

export const ORDER_LINE_TYPES: readonly string[] = Object.values(OrderLineType);

/** Dòng giữ kho. COMBO chỉ có giá và SERVICE không cần hàng, nên hai loại này không bao giờ bị trừ kho. */
export const STOCKED_LINE_TYPES: readonly string[] = [
  OrderLineType.PRODUCT,
  OrderLineType.COMBO_COMPONENT,
];

/** Nguồn đơn. MANUAL và SHOPEE đều là đơn khách đặt online; MANUAL là đơn nhân viên nhập tay. Bán tại quầy cũng lưu MANUAL, khác ở `fulfillmentType = TAKEAWAY`. Không có kênh website riêng. */
export const OrderChannel = {
  MANUAL: 'MANUAL',
  SHOPEE: 'SHOPEE',
} as const;

export type OrderChannel = (typeof OrderChannel)[keyof typeof OrderChannel];

export const ORDER_CHANNELS: readonly string[] = Object.values(OrderChannel);

/** Cách hàng đến tay khách. TAKEAWAY là bán tại quầy: thu tiền và trừ kho ngay, ngoài hành trình đơn. */
export const FulfillmentType = {
  TAKEAWAY: 'TAKEAWAY',
  STORE_PICKUP: 'STORE_PICKUP',
  HOME_DELIVERY: 'HOME_DELIVERY',
} as const;

export type FulfillmentType =
  (typeof FulfillmentType)[keyof typeof FulfillmentType];

export const FULFILLMENT_TYPES: readonly string[] =
  Object.values(FulfillmentType);

/** Thẻ ưu tiên nhân viên dùng để chọn đơn giao tiếp theo (cùng requestedDeliveryDate). Danh sách cố định, cao nhất đứng cuối để sắp xếp được. */
export const OrderPriority = {
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  URGENT: 'URGENT',
} as const;

export type OrderPriority = (typeof OrderPriority)[keyof typeof OrderPriority];

export const ORDER_PRIORITIES: readonly string[] = Object.values(OrderPriority);

/** Suy ra từ các dòng Payment của đơn (Phase 2, E-5) - không bao giờ đặt từ request. */
export const OrderPaymentStatus = {
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
} as const;

export type OrderPaymentStatus =
  (typeof OrderPaymentStatus)[keyof typeof OrderPaymentStatus];

export const ORDER_PAYMENT_STATUSES: readonly string[] =
  Object.values(OrderPaymentStatus);

/** `Payment.remittanceStatus`: tiền shipper thu hộ đã về tới chủ shop chưa? Chỉ PENDING khi thu tiền mặt lúc giao. */
export const RemittanceStatus = {
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
} as const;

export type RemittanceStatus =
  (typeof RemittanceStatus)[keyof typeof RemittanceStatus];

export const REMITTANCE_STATUSES: readonly string[] =
  Object.values(RemittanceStatus);
