/** Yêu cầu sản xuất chỉ là danh sách theo dõi và gọi xưởng, không tự gửi gì. Nhân viên chuyển DRAFT → SENT hoặc huỷ; PARTIALLY_RECEIVED và COMPLETED chỉ đến từ phiếu nhận (`POST /production-requests/:id/receive`). */
export const ProductionRequestStatus = {
  DRAFT: 'DRAFT',
  /** Đã gọi xưởng. Từ đây thông số đặt riêng bị khoá. */
  SENT: 'SENT',
  PARTIALLY_RECEIVED: 'PARTIALLY_RECEIVED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;

export type ProductionRequestStatus =
  (typeof ProductionRequestStatus)[keyof typeof ProductionRequestStatus];

export const PRODUCTION_REQUEST_STATUSES: readonly string[] = Object.values(
  ProductionRequestStatus,
);

/** Yêu cầu còn chờ hàng, kể cả nháp - danh sách sản xuất trừ các yêu cầu này trước khi gọi phần thiếu là "chưa đặt". */
export const OPEN_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.DRAFT,
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

/** Đã gửi xưởng và chưa giao đủ - là `onOrderQuantity` của danh sách. DRAFT được tính riêng (`draftQuantity`) vì chưa ai gọi xưởng (hợp đồng §3). */
export const ON_ORDER_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

export const RECEIVABLE_PRODUCTION_REQUEST_STATUSES: readonly string[] =
  ON_ORDER_PRODUCTION_REQUEST_STATUSES;

/** Trạng thái người dùng tự đặt (`PATCH /production-requests/:id/status`). PARTIALLY_RECEIVED chỉ đến từ phiếu nhận; COMPLETED cũng vậy, trừ khi đóng yêu cầu giao thiếu (2026-10-05). */
export const MANUAL_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.CANCELLED,
  ProductionRequestStatus.COMPLETED,
];

/** Không trạng thái nào đưa yêu cầu ra khỏi nhóm này. */
export const FINAL_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];

/** Phiếu giao của xưởng gắn với yêu cầu SENT / PARTIALLY_RECEIVED (2026-10-09). PENDING chưa đụng tới kho; RECEIVED chỉ do địa điểm nhận xác nhận - lúc đó tồn kho và công nợ xưởng tăng. */
export const ProductionDeliveryStatus = {
  PENDING: 'PENDING',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
} as const;

export type ProductionDeliveryStatus =
  (typeof ProductionDeliveryStatus)[keyof typeof ProductionDeliveryStatus];

export const PRODUCTION_DELIVERY_STATUSES: readonly string[] = Object.values(
  ProductionDeliveryStatus,
);

/** Những gì nhân viên xưởng thấy: mọi yêu cầu đã gửi tới xưởng. DRAFT chưa gửi nên vẫn là việc của shop. */
export const WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];
