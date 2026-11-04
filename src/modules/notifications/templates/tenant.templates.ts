import type { NotificationContent } from '../notification-content.type';

export const TenantNotificationTemplates = {
  bankAccountUpdated: (
    tenantName: string,
    bankName: string | null,
    accountNumber: string | null,
  ): NotificationContent => ({
    type: 'SYSTEM_TENANT_BANK_UPDATED',
    title: 'Cửa hàng cập nhật tài khoản ngân hàng',
    description: `Cửa hàng "${tenantName}" vừa lưu thông tin ngân hàng (${bankName ?? '-'} - ${accountNumber ?? '-'}). Thêm tài khoản này vào SePay của nền tảng; hệ thống sẽ tự đánh dấu đã liên kết khi thấy tài khoản.`,
  }),

  sepayLinked: (): NotificationContent => ({
    type: 'SEPAY_LINKED',
    title: 'Tài khoản ngân hàng đã được liên kết SePay',
    description:
      'Tài khoản ngân hàng của cửa hàng bạn đã được quản trị viên liên kết với cổng thanh toán SePay. Bạn đã có thể nhận thanh toán đơn hàng qua mã QR.',
    link: '/settings',
  }),
};
