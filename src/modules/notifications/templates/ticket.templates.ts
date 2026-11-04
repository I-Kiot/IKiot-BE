import type { NotificationContent } from '../notification-content.type';

/** Copy cho ticket hỗ trợ. Hai phía cố ý không thông báo đối xứng: operator làm việc trong admin console nên system notification là đủ; chủ shop đã tắt máy nên cần thông báo đến inbox/push. */
export const TicketNotificationTemplates = {
  /** Gửi cho operator của nền tảng: một shop vừa mở một luồng hỗ trợ. */
  created: (
    tenantName: string,
    ticketId: string,
    title: string,
  ): NotificationContent => ({
    type: 'SYSTEM_TICKET_CREATED',
    title: 'Yêu cầu hỗ trợ mới',
    description: `Cửa hàng "${tenantName}" đã gửi yêu cầu hỗ trợ mã ${ticketId}: "${title}"`,
  }),

  /** Gửi lại cho chủ shop khi bộ phận hỗ trợ đã trả lời. */
  replied: (title: string): NotificationContent => ({
    type: 'TICKET_REPLIED',
    title: 'Yêu cầu hỗ trợ đã được phản hồi',
    description: `Bộ phận hỗ trợ đã trả lời ticket ${title}.`.trim(),
    link: '/tickets',
  }),
};
