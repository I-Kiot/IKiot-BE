import type { NotificationContent } from '../notification-content.type';

const link = (shipmentId: string) => `/shipments/${shipmentId}`;

/** Nội dung thông báo của mảng giao hàng (C-2, C-8). */
export const ShipmentNotificationTemplates = {
  /** Người nhận vừa được gán làm shipper / thợ – lúc tạo shipment hoặc khi đổi người. */
  assigned: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_ASSIGNED',
    title: 'Bạn có đơn cần giao',
    description: `Bạn được giao đơn ${orderCode}.`,
    link: link(shipmentId),
  }),

  /** Báo người phụ trách đơn: giao không thành, hàng phải đi đường hoàn hàng. */
  failed: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_FAILED',
    title: 'Giao hàng không thành',
    description: `Đơn ${orderCode} giao không thành, cần tạo phiếu hoàn hàng.`,
    link: link(shipmentId),
  }),
};
