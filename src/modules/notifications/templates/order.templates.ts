import type { NotificationContent } from '../notification-content.type';

const vnd = (amount: number) => `${amount.toLocaleString('vi-VN')}đ`;

/** Notification copy for the sales domain. */
export const OrderNotificationTemplates = {
  /** A SePay transfer landing is the one order event genuinely worth a push: it arrives minutes after the customer walked up, when the cashier is no longer looking at that screen. */
  paid: (paymentReference: string, amount: number): NotificationContent => ({
    type: 'ORDER_PAID',
    title: 'Khách đã thanh toán',
    description: `Đơn hàng ${paymentReference} đã nhận được ${vnd(amount)} qua chuyển khoản.`,
    link: '/sales/invoices',
  }),
};
