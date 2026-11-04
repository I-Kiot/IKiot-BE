import type { NotificationContent } from '../notification-content.type';

const link = (shipmentId: string) => `/shipments/${shipmentId}`;

/** Nội dung thông báo giao hàng (task C-2, C-8). */
export const ShipmentNotificationTemplates = {
  /** Gửi khi vừa gán người làm shipper/thợ: lúc tạo shipment hoặc khi đổi người. */
  assigned: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_ASSIGNED',
    title: 'Bạn có đơn cần giao',
    description: `Bạn được giao đơn ${orderCode}. Tới kho lấy hàng rồi bấm "Xác nhận đã lấy hàng".`,
    link: link(shipmentId),
  }),

  pickedUp: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_PICKED_UP',
    title: 'Shipper đã lấy hàng',
    description: `Đơn ${orderCode} đã được shipper lấy hàng, chờ xác nhận Đang vận chuyển.`,
    link: link(shipmentId),
  }),

  /** Gửi người phụ trách đơn và chủ shop. Hàng vẫn ở shipper: có thể giao lại, hoặc xác nhận hoàn về shop. */
  failed: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_FAILED',
    title: 'Giao hàng không thành',
    description: `Đơn ${orderCode} giao không thành, hàng chưa về shop. Shipper có thể giao lại; khi hàng đã hoàn về, hãy xác nhận trong chi tiết đơn.`,
    link: link(shipmentId),
  }),
};
