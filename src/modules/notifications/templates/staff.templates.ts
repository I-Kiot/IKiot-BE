import type { NotificationContent } from '../notification-content.type';

/** Notification copy for the staff-account domain. */
export const StaffNotificationTemplates = {
  /** Sent to the employee whose login was just switched on. Never put the password in here - the notification is written to the database and pushed over the socket, two places outside our control, for a secret the manager already has in front of them. */
  accountActivated: (): NotificationContent => ({
    type: 'STAFF_ACCOUNT_CREATED',
    title: 'Tài khoản của bạn đã được kích hoạt',
    description: 'Bạn đã có thể đăng nhập vào hệ thống iKiot.',
    link: '/dashboard',
  }),
};
