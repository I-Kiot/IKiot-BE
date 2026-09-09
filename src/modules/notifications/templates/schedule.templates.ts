import type { NotificationContent } from '../notification-content.type';

/** Notification copy for rostering. Deliberately says nothing about which shifts: one notification covers a whole bulk assignment, so naming a date would be wrong for everyone but the first. */
export const ScheduleNotificationTemplates = {
  assigned: (): NotificationContent => ({
    type: 'SCHEDULE_ASSIGNED',
    title: 'Bạn có lịch làm việc mới',
    description:
      'Quản lý vừa xếp ca cho bạn. Xem lịch làm việc để biết chi tiết.',
    link: '/staffs/schedule',
  }),
};
