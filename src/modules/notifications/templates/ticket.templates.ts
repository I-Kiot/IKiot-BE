import type { NotificationContent } from '../notification-content.type';

/** Notification copy for support threads. The two sides never notify symmetrically on purpose: operators live in the admin console, so a system notification is enough, while the shop owner who filed the ticket has closed the laptop. */
export const TicketNotificationTemplates = {
  /** To the platform operators: a shop has opened a thread. */
  created: (
    tenantName: string,
    ticketId: string,
    title: string,
  ): NotificationContent => ({
    type: 'SYSTEM_TICKET_CREATED',
    title: 'Yêu cầu hỗ trợ mới',
    description: `Cửa hàng "${tenantName}" đã gửi yêu cầu hỗ trợ mã ${ticketId}: "${title}"`,
  }),

  /** Back to the shop's owners once support has answered. */
  replied: (title: string): NotificationContent => ({
    type: 'TICKET_REPLIED',
    title: 'Yêu cầu hỗ trợ đã được phản hồi',
    description: `Bộ phận hỗ trợ đã trả lời ticket ${title}.`.trim(),
    link: '/tickets',
  }),
};
