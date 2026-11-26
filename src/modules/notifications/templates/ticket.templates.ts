import type { NotificationContent } from '../notification-content.type';

/** Nội dung thông báo ticket hỗ trợ. */
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
