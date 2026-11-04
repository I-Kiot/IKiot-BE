import type { NotificationContent } from '../notification-content.type';

const vnd = (amount: number) => `${amount.toLocaleString('vi-VN')}đ`;

export const OrderNotificationTemplates = {
  /** Tiền chuyển khoản SePay về là sự kiện duy nhất đáng push: đến vài phút sau khi khách đã rời quầy, thu ngân không còn nhìn màn hình. */
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
    // Trang đơn mở hộp thoại "Xác nhận đã nhận tiền" nhờ flag này (OrderActions).
    link: `/sales/orders/${orderId}?confirmCash=1`,
  }),

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
