import type { NotificationContent } from '../notification-content.type';

const link = (shipmentId: string) => `/shipments/${shipmentId}`;

/** Nội dung thông báo của mảng giao hàng (C-2, C-8). */
export const ShipmentNotificationTemplates = {
  /** Người nhận vừa được gán làm shipper / thợ – lúc tạo shipment hoặc khi đổi người. */
  assigned: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_ASSIGNED',
    title: 'Bạn có đơn cần giao',
    description: `Bạn được giao đơn ${orderCode}. Tới kho lấy hàng rồi bấm "Xác nhận đã lấy hàng".`,
    link: link(shipmentId),
  }),

  /** Báo người phụ trách đơn: shipper đã lấy hàng, đơn chờ xác nhận Đang vận chuyển. */
  pickedUp: (shipmentId: string, orderCode: string): NotificationContent => ({
    type: 'SHIPMENT_PICKED_UP',
    title: 'Shipper đã lấy hàng',
    description: `Đơn ${orderCode} đã được shipper lấy hàng, chờ xác nhận Đang vận chuyển.`,
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
