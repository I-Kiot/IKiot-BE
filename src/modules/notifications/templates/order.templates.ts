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

  /** Tiền chuyển khoản về nhưng không chốt được (mã QR đã hết hạn và đơn đã huỷ / đã thu, khoản bị thay bằng tiền mặt hay mã mới): chủ shop phải hoàn tiền hoặc đối soát bằng tay. */
  lateTransferNeedsAction: (
    orderId: string,
    orderCode: string,
    amount: number,
    sepayTransactionId: string | null,
    isPos: boolean,
  ): NotificationContent => ({
    type: 'ORDER_LATE_TRANSFER',
    title: 'Tiền về sau khi mã QR hết hạn',
    description: `Đơn ${orderCode} nhận ${vnd(amount)} chuyển khoản (mã giao dịch SePay ${sepayTransactionId ?? 'không rõ'}) sau khi mã QR đã hết hạn hoặc đơn đã thu/huỷ - cần hoàn tiền hoặc đối soát.`,
    link: isPos ? '/sales/invoices' : `/sales/orders/${orderId}`,
  }),

  /** Khách chuyển thiếu so với mã QR: tiền đã về và được ghi là khoản trả một phần; đơn còn thiếu `due`, người phụ trách cần thu nốt (mã QR mới hay tiền mặt). */
  partialTransfer: (
    orderId: string,
    orderCode: string,
    amount: number,
    due: number,
    isPos: boolean,
  ): NotificationContent => ({
    type: 'ORDER_PARTIAL_TRANSFER',
    title: 'Khách chuyển thiếu tiền',
    description: `Đơn ${orderCode} nhận ${vnd(amount)} chuyển khoản, còn thiếu ${vnd(due)} - thu nốt phần còn lại.`,
    link: isPos ? '/check-out' : `/sales/orders/${orderId}`,
  }),

  /** Khách chuyển dư so với đơn: chủ shop hoàn lại phần dư. */
  overpaid: (
    orderId: string,
    orderCode: string,
    overpaidBy: number,
  ): NotificationContent => ({
    type: 'ORDER_OVERPAID',
    title: 'Khách trả dư tiền',
    description: `Đơn ${orderCode} khách đã trả dư ${vnd(overpaidBy)} - cần hoàn lại phần dư.`,
    link: `/sales/orders/${orderId}`,
  }),

  /** Tiền chuyển khoản về nhưng không gắn được đơn nào (không có mã, mã lạ): chủ shop đối soát, hoàn tiền hoặc đánh dấu đã xử lý. */
  unmatchedTransfer: (
    amount: number,
    content: string | null,
    sepayTransactionId: string | null,
  ): NotificationContent => ({
    type: 'ORDER_UNMATCHED_TRANSFER',
    title: 'Tiền về không gắn được đơn',
    description: `Nhận ${vnd(amount)} chuyển khoản (mã giao dịch SePay ${sepayTransactionId ?? 'không rõ'}, nội dung "${content ?? ''}") nhưng không khớp đơn nào - cần đối soát hoặc hoàn tiền.`,
    link: '/cashflow',
  }),

  /** Gửi operator: tiền vào một tài khoản không thuộc shop nào (webhook dùng key dùng chung). */
  unmatchedSystemTransfer: (
    amount: number,
    accountNumber: string | null,
    content: string | null,
  ): NotificationContent => ({
    type: 'SYSTEM_SEPAY_UNMATCHED',
    title: 'SePay: tiền về tài khoản không thuộc shop nào',
    description: `Nhận ${vnd(amount)} vào tài khoản ${accountNumber ?? 'không rõ'} (nội dung "${content ?? ''}") nhưng không có shop nào dùng tài khoản này.`,
    link: '/admin/notifications',
  }),
};
