import type { NotificationContent } from '../notification-content.type';

const vnd = (amount: number) => `${amount.toLocaleString('vi-VN')} VNĐ`;

/** Notification copy for the supplier/payables domain. */
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

  /** Sent once, on the receipt that pushes a supplier's debt past the warning ratio - to owners, not to the person receiving the goods. */
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
