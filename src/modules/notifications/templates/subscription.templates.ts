import type { NotificationContent } from '../notification-content.type';

/** Notification copy for the subscription/billing domain, kept out of NotificationService so that stays domain-agnostic delivery machinery. */
export const SubscriptionNotificationTemplates = {
  activated: (): NotificationContent => ({
    type: 'SUBSCRIPTION_ACTIVATED',
    title: 'Gói dịch vụ đã được kích hoạt',
    description:
      'Thanh toán của bạn đã được xác nhận, gói dịch vụ đang hoạt động.',
    link: '/settings/billing',
  }),

  trialExpired: (): NotificationContent => ({
    type: 'SUBSCRIPTION_EXPIRED',
    title: 'Bản dùng thử đã kết thúc',
    description: 'Thời gian dùng thử đã hết. Nâng cấp gói để tiếp tục sử dụng.',
    link: '/settings/billing',
  }),

  expired: (): NotificationContent => ({
    type: 'SUBSCRIPTION_EXPIRED',
    title: 'Gói dịch vụ đã hết hạn',
    description:
      'Gói dịch vụ đã hết hạn và hết thời gian gia hạn. Vui lòng thanh toán để khôi phục.',
    link: '/settings/billing',
  }),

  expiring: (daysLeft: number, planName: string): NotificationContent => ({
    type: 'SUBSCRIPTION_EXPIRING',
    title: 'Gói dịch vụ sắp hết hạn',
    description: `Gói ${planName} của bạn sẽ hết hạn sau ${daysLeft} ngày. Gia hạn để không bị gián đoạn.`,
    link: '/settings/billing',
  }),
};
