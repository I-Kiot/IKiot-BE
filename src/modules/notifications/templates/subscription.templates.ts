import type { NotificationContent } from '../notification-content.type';

/** Copy gói dịch vụ/billing nằm ngoài NotificationService để service đó chỉ lo việc gửi, không biết về domain. */
export const SubscriptionNotificationTemplates = {
  activated: (): NotificationContent => ({
    type: 'SUBSCRIPTION_ACTIVATED',
    title: 'Gói dịch vụ đã được kích hoạt',
    description:
      'Thanh toán của bạn đã được xác nhận, gói dịch vụ đang hoạt động.',
    link: '/settings/billing',
  }),

  /** Gửi operator: tiền về tài khoản iKiot nhưng gói không được kích hoạt; cần xử lý tay. */
  platformTransferNeedsAction: (
    outcome: string,
    amount: number,
    reference: string | null,
    content: string | null,
  ): NotificationContent => ({
    type: 'SYSTEM_PLATFORM_TRANSFER_NEEDS_ACTION',
    title: 'Tiền gói dịch vụ cần xử lý tay',
    description: `Nhận ${amount.toLocaleString('vi-VN')}đ vào tài khoản iKiot (mã ${reference ?? 'không có'}, nội dung "${content ?? ''}"), kết quả ${outcome}: gói chưa được kích hoạt, cần đối soát hoặc hoàn tiền.`,
    link: '/admin/notifications',
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
