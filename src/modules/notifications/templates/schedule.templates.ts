import type { NotificationContent } from '../notification-content.type';

/** Thông báo xếp ca không nêu ca cụ thể. */
export const ScheduleNotificationTemplates = {
  assigned: (): NotificationContent => ({
    type: 'SCHEDULE_ASSIGNED',
    title: 'Bạn có lịch làm việc mới',
    description:
      'Quản lý vừa xếp ca cho bạn. Xem lịch làm việc để biết chi tiết.',
    link: '/staffs/schedule',
  }),
};
