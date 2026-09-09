import type { NotificationContent } from '../notification-content.type';

/** Notification copy for the shop-settings domain: two halves of one manual workflow, where a shop saves its bank account and is told once an operator has linked it with SePay by hand. */
export const TenantNotificationTemplates = {
  /** To the platform operators: a shop has saved bank details that need linking. */
  bankAccountUpdated: (
    tenantName: string,
    bankName: string | null,
    accountNumber: string | null,
  ): NotificationContent => ({
    type: 'SYSTEM_TENANT_BANK_UPDATED',
    title: 'Cửa hàng cập nhật tài khoản ngân hàng',
    description: `Cửa hàng "${tenantName}" vừa lưu thông tin ngân hàng (${bankName ?? '-'} - ${accountNumber ?? '-'}). Cần liên kết SePay thủ công.`,
  }),

  /** Back to the shop's owners once an operator has linked the account. */
  sepayLinked: (): NotificationContent => ({
    type: 'SEPAY_LINKED',
    title: 'Tài khoản ngân hàng đã được liên kết SePay',
    description:
      'Tài khoản ngân hàng của cửa hàng bạn đã được quản trị viên liên kết với cổng thanh toán SePay. Bạn đã có thể nhận thanh toán đơn hàng qua mã QR.',
    link: '/settings',
  }),
};
