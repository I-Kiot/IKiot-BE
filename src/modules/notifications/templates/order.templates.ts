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

  /** Gửi người vừa được giao phụ trách đơn, trừ khi họ tự nhận. */
  assigned: (orderId: string, orderCode: string): NotificationContent => ({
    type: 'ORDER_ASSIGNED',
    title: 'Bạn được giao phụ trách đơn',
    description: `Bạn là người phụ trách đơn ${orderCode} từ bây giờ.`,
    link: `/sales/orders/${orderId}`,
  }),

  /** Gửi người vừa thôi phụ trách đơn, trừ khi chính họ giao lại. */
  unassigned: (orderId: string, orderCode: string): NotificationContent => ({
    type: 'ORDER_UNASSIGNED',
    title: 'Bạn không còn phụ trách đơn',
    description: `Đơn ${orderCode} đã được giao cho người khác phụ trách.`,
    link: `/sales/orders/${orderId}`,
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
