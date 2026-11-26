import type { NotificationContent } from '../notification-content.type';

export const StaffNotificationTemplates = {
  /** Báo nhân viên vừa được bật đăng nhập, không kèm mật khẩu. */
  accountActivated: (): NotificationContent => ({
    type: 'STAFF_ACCOUNT_CREATED',
    title: 'Tài khoản của bạn đã được kích hoạt',
    description: 'Bạn đã có thể đăng nhập vào hệ thống iKiot.',
    link: '/dashboard',
  }),
};
