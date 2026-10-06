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
};
