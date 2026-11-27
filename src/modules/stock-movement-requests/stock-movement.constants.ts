/** Loại phiếu kho: nhập, xuất, trả, kiểm kê. */
export const MovementType = {
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',
  RETURN: 'RETURN',
  ADJUST: 'ADJUST',
} as const;

export type MovementType = (typeof MovementType)[keyof typeof MovementType];

export const MOVEMENT_TYPES: readonly string[] = Object.values(MovementType);

/** Trạng thái phiếu kho. */
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

/** Trạng thái phiếu còn dở. */
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
