import type { NotificationContent } from '../notification-content.type';

const vnd = (amount: number) => `${amount.toLocaleString('vi-VN')} VNĐ`;

export const SupplierNotificationTemplates = {
  debtPaid: (
    supplierName: string,
    amount: number,
    remainingDebt: number,
  ): NotificationContent => ({
    type: 'SYSTEM',
    title: 'Thanh toán công nợ nhà cung cấp',
    description: `Đã trả nhà cung cấp ${supplierName} ${vnd(amount)}. Còn nợ ${vnd(remainingDebt)}.`,
    link: '/suppliers',
  }),

  /** Chỉ gửi một lần, ở phiếu nhập làm công nợ NCC vượt ngưỡng cảnh báo; gửi cho chủ, không gửi người nhận hàng. */
  creditLimitWarning: (
    supplierName: string,
    outstandingDebt: number,
    creditLimit: number,
  ): NotificationContent => ({
    type: 'SYSTEM',
    title: 'Cảnh báo hạn mức công nợ',
    description: `Công nợ của nhà cung cấp ${supplierName} đã đạt ${((outstandingDebt / creditLimit) * 100).toFixed(1)}% hạn mức (${vnd(outstandingDebt)} / ${vnd(creditLimit)}).`,
    link: '/suppliers',
  }),
};
