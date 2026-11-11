/**
 * Loại sự kiện trong nhật ký thao tác trên đơn (`order_events.type`). Thêm một loại = migration mới tạo lại CHECK `order_events_type_check`;
 * `order-event-type.spec.ts` đọc migration cuối cùng định nghĩa CHECK đó và fail nếu danh sách lệch với file này.
 */
export const OrderEventType = {
  CREATED: 'CREATED',
  EDITED: 'EDITED',
  CUSTOMIZATION_SET: 'CUSTOMIZATION_SET',
  ASSIGNEE_CHANGED: 'ASSIGNEE_CHANGED',
  PRIORITY_CHANGED: 'PRIORITY_CHANGED',
  PACKED: 'PACKED',
  SHIPMENT_CREATED: 'SHIPMENT_CREATED',
  PICKED_UP: 'PICKED_UP',
  DRIVER_CHANGED: 'DRIVER_CHANGED',
  SHIPPED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  DEPOSIT_RECORDED: 'DEPOSIT_RECORDED',
  CASH_COLLECTED: 'CASH_COLLECTED',
  QR_PAID: 'QR_PAID',
  REMITTANCE_CONFIRMED: 'REMITTANCE_CONFIRMED',
  PAID_OFFLINE: 'PAID_OFFLINE',
  PICKUP_COLLECTED: 'PICKUP_COLLECTED',
  PICKUP_HANDED_OVER: 'PICKUP_HANDED_OVER',
  CANCELLED: 'CANCELLED',
  STATUS_CHANGED: 'STATUS_CHANGED',
  RETURN_CREATED: 'RETURN_CREATED',
  RETURN_RECEIVED: 'RETURN_RECEIVED',
  RETURN_INSPECTED: 'RETURN_INSPECTED',
  RETURN_CANCELLED: 'RETURN_CANCELLED',
  REPLACEMENT_LINKED: 'REPLACEMENT_LINKED',
  PRODUCTION_REQUESTED: 'PRODUCTION_REQUESTED',
  PRODUCTION_RECEIVED: 'PRODUCTION_RECEIVED',
  /** Tiền trả lại khách ngoài huỷ đơn: khi kiểm hàng trả, trả hàng đơn quầy, hoàn phần khách chuyển dư. Huỷ đơn mang số hoàn trong sự kiện CANCELLED. */
  REFUNDED: 'REFUNDED',
  /** Chủ shop quyết định giữ tiền treo của đơn đã kết thúc (RETURNED / CANCELLED chưa quyết định): ghi OTHER_INCOME. Hoàn tiền thì dùng REFUNDED. */
  HELD_KEPT: 'HELD_KEPT',
} as const;

export type OrderEventType =
  (typeof OrderEventType)[keyof typeof OrderEventType];

export const ORDER_EVENT_TYPES: readonly string[] =
  Object.values(OrderEventType);

/** `order_events.source`: ai gây ra sự kiện. SYSTEM là tác vụ nền: hiện chỉ cron QR hết hạn (`sepay-qr-expiry.cron.ts`) tự huỷ đơn quầy. */
export const OrderEventSource = {
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  WEBHOOK: 'WEBHOOK',
} as const;

export type OrderEventSource =
  (typeof OrderEventSource)[keyof typeof OrderEventSource];

export const ORDER_EVENT_SOURCES: readonly string[] =
  Object.values(OrderEventSource);

/** `metadata.refType`: chứng từ liên quan để màn hình dẫn tới trang của nó. */
export const OrderEventRefType = {
  SHIPMENT: 'SHIPMENT',
  ORDER_RETURN: 'ORDER_RETURN',
  PRODUCTION_REQUEST: 'PRODUCTION_REQUEST',
  ORDER: 'ORDER',
} as const;

export type OrderEventRefType =
  (typeof OrderEventRefType)[keyof typeof OrderEventRefType];
