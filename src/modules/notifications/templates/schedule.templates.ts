import type { NotificationContent } from '../notification-content.type';

/** Cố ý không nêu ca nào: một thông báo phủ cả đợt xếp ca hàng loạt, nêu ngày sẽ sai với mọi người trừ người đầu tiên. */
export const ScheduleNotificationTemplates = {
  assigned: (): NotificationContent => ({
    type: 'SCHEDULE_ASSIGNED',
    title: 'Bạn có lịch làm việc mới',
    description:
      'Quản lý vừa xếp ca cho bạn. Xem lịch làm việc để biết chi tiết.',
    link: '/staffs/schedule',
  }),
};
