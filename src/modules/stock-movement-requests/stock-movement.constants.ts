/** Mục đích phiếu: `IMPORT` (từ NCC, loại duy nhất có công nợ), `EXPORT` (giữa địa điểm của mình), `RETURN` (chuyển ngược về kho, tách riêng để báo cáo), `ADJUST` (kiểm kê chỉnh số tại một địa điểm). */
export const MovementType = {
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  RETURN: 'RETURN',
  ADJUST: 'ADJUST',
} as const;

export type MovementType = (typeof MovementType)[keyof typeof MovementType];

export const MOVEMENT_TYPES: readonly string[] = Object.values(MovementType);

/** Vòng đời phiếu. `DRAFT → OPENING → CLOSED → IN_TRANSIT → RECEIVED` là luồng chuyển; IMPORT và ADJUST bắt đầu ở `PENDING` (không có gì để soạn), ADJUST kết thúc ở `COMPLETED` (không có gì về). */
export const MovementStatus = {
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  OPENING: 'OPENING',
  CLOSED: 'CLOSED',
  IN_TRANSIT: 'IN_TRANSIT',
  RECEIVED: 'RECEIVED',
  CANCELLED: 'CANCELLED',
  COMPLETED: 'COMPLETED',
} as const;

export type MovementStatus =
  (typeof MovementStatus)[keyof typeof MovementStatus];

export const MOVEMENT_STATUSES: readonly string[] =
  Object.values(MovementStatus);

/** Trạng thái phiếu còn chạm tới món của nó; `ProductService` dùng để từ chối ngừng sản phẩm đang nằm trong phiếu dở. */
export const OPEN_MOVEMENT_STATUSES: readonly string[] = [
  MovementStatus.DRAFT,
  MovementStatus.PENDING,
  MovementStatus.OPENING,
  MovementStatus.IN_TRANSIT,
];

/** Không thao tác nào đưa phiếu ra khỏi các trạng thái này; huỷ bị từ chối. */
export const FINAL_MOVEMENT_STATUSES: readonly string[] = [
  MovementStatus.RECEIVED,
  MovementStatus.COMPLETED,
  MovementStatus.CANCELLED,
];
