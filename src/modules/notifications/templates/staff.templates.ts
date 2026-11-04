import type { NotificationContent } from '../notification-content.type';

export const StaffNotificationTemplates = {
  /** Gửi cho nhân viên vừa được bật đăng nhập. Không đưa mật khẩu vào đây: thông báo được ghi DB và push qua socket, hai nơi ngoài tầm kiểm soát, trong khi quản lý đã có mật khẩu đó. */
  accountActivated: (): NotificationContent => ({
    type: 'STAFF_ACCOUNT_CREATED',
    title: 'Tài khoản của bạn đã được kích hoạt',
    description: 'Bạn đã có thể đăng nhập vào hệ thống iKiot.',
    link: '/dashboard',
  }),
};
