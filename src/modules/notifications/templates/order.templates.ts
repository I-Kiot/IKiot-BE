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

  /** Shipper thu tiền mặt khi giao: tiền đang ở tay shipper, chủ cần xác nhận khi nhận đủ (A-10). */
  cashAwaitingRemittance: (
    orderId: string,
    orderCode: string,
    amount: number,
  ): NotificationContent => ({
    type: 'ORDER_CASH_AWAITING_REMITTANCE',
    title: 'Shipper đang giữ tiền mặt',
    description: `Đơn ${orderCode} đã giao, shipper thu ${vnd(amount)} tiền mặt - chờ nộp lại cho chủ.`,
    // The order page opens its "Xác nhận đã nhận tiền" dialog on this flag (OrderActions).
    link: `/sales/orders/${orderId}?confirmCash=1`,
  }),

  /** Khách chuyển khoản QR lúc giao và tiền đã về: đơn hoàn thành. */
  deliveryTransferReceived: (
    orderCode: string,
    amount: number,
  ): NotificationContent => ({
    type: 'ORDER_DELIVERY_TRANSFER_RECEIVED',
    title: 'Tiền giao hàng đã về',
    description: `Đơn ${orderCode} đã nhận ${vnd(amount)} qua chuyển khoản - đơn hoàn thành.`,
    link: '/shipments',
  }),
};
