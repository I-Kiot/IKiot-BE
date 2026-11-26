/** OVERTIME là giờ làm thêm, không bao giờ bị tính là đi muộn. */
export const ScheduleType = {
  NORMAL: 'NORMAL',
  OVERTIME: 'OVERTIME',
} as const;

export const SCHEDULE_TYPES = Object.values(ScheduleType);

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
