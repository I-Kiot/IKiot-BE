/** Loại ca (NORMAL / OVERTIME) đã bỏ 2026-11-26: nó chỉ có nghĩa với bảng lương, đã ra khỏi phạm vi. */
export const ScheduleStatus = {
  SCHEDULED: 'SCHEDULED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  DELETED: 'DELETED',
} as const;

/** Client chỉ được lọc các trạng thái này; DELETED không ai cần xem. */
export const FILTERABLE_SCHEDULE_STATUSES = [
  ScheduleStatus.SCHEDULED,
  ScheduleStatus.COMPLETED,
  ScheduleStatus.CANCELLED,
];

/** Trạng thái lịch còn chiếm giờ của người. */
export const LIVE_SCHEDULE_STATUSES = [
  ScheduleStatus.SCHEDULED,
  ScheduleStatus.COMPLETED,
];
