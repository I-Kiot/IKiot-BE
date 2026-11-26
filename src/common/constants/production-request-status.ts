/** Trạng thái YCSX: nhân viên gửi hoặc huỷ, nhận một phần / hoàn tất chỉ đến từ phiếu nhận. */
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

/** YCSX còn chờ hàng, kể cả nháp. */
export const OPEN_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.DRAFT,
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

/** YCSX đã gửi xưởng và chưa giao đủ. */
export const ON_ORDER_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
];

export const RECEIVABLE_PRODUCTION_REQUEST_STATUSES: readonly string[] =
  ON_ORDER_PRODUCTION_REQUEST_STATUSES;

/** Trạng thái người dùng tự đặt được qua `PATCH /production-requests/:id/status`. */
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

/** Trạng thái phiếu giao xưởng: RECEIVED khi nơi nhận xác nhận, lúc đó mới tăng tồn và công nợ. */
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

/** Trạng thái YCSX nhân viên xưởng thấy được (đã gửi tới xưởng). */
export const WORKSHOP_VISIBLE_PRODUCTION_REQUEST_STATUSES: readonly string[] = [
  ProductionRequestStatus.SENT,
  ProductionRequestStatus.PARTIALLY_RECEIVED,
  ProductionRequestStatus.COMPLETED,
  ProductionRequestStatus.CANCELLED,
];
