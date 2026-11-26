import type { NotificationContent } from '../notification-content.type';

/** Danh sách sản xuất đã lọc đúng một dòng; mọi thông báo sản xuất đều trỏ về đây (contract §3). */
const listLink = (locationId: string | null, productItemId: string) => {
  const params = new URLSearchParams({ productItemId });
  if (locationId) params.set('locationId', locationId);
  return `/exchange/production-list?${params.toString()}`;
};

/** Nội dung thông báo sản xuất / xưởng (hành trình GĐ1 – Bước 4). */
export const ProductionRequestNotificationTemplates = {
  /** Báo khi dòng vừa chuyển sang thiếu. */
  shortageDetected: (args: {
    label: string;
    locationName: string | null;
    locationId: string | null;
    productItemId: string;
    shortQuantity: number;
  }): NotificationContent => ({
    type: 'PRODUCTION_SHORTAGE',
    title: 'Cần sản xuất thêm',
    description: `${args.label} tại ${args.locationName ?? 'đơn chưa chọn kho'} đang thiếu ${args.shortQuantity}, chưa đặt xưởng.`,
    link: listLink(args.locationId, args.productItemId),
  }),

  /** Hàng xưởng về cho SKU mà có đơn đang chờ; gửi người phụ trách các đơn đó để họ đóng gói. */
  goodsArrived: (args: {
    label: string;
    quantity: number;
    locationName: string;
    locationId: string;
    productItemId: string;
    requestCode: string;
  }): NotificationContent => ({
    type: 'PRODUCTION_GOODS_ARRIVED',
    title: 'Hàng xưởng đã về',
    description: `${args.quantity} ${args.label} theo ${args.requestCode} đã nhập vào ${args.locationName}. Có đơn bạn phụ trách đang chờ mặt hàng này.`,
    link: listLink(args.locationId, args.productItemId),
  }),

  /** Xưởng lập phiếu giao; gửi manager của location nhận, họ phải đếm và xác nhận trước khi tồn kho tăng. */
  deliveryCreated: (args: {
    deliveryCode: string;
    requestCode: string;
    workshopName: string;
    locationName: string;
    totalQuantity: number;
  }): NotificationContent => ({
    type: 'PRODUCTION_DELIVERY_CREATED',
    title: 'Xưởng giao hàng – chờ nhận',
    description: `${args.workshopName} báo giao ${args.totalQuantity} sản phẩm theo ${args.requestCode} (phiếu ${args.deliveryCode}) tới ${args.locationName}. Kiểm hàng và xác nhận để nhập kho.`,
    link: `/exchange/production-deliveries?status=PENDING`,
  }),

  /** Location đã xác nhận phiếu giao; gửi nhân viên xưởng. */
  deliveryReceived: (args: {
    deliveryCode: string;
    requestCode: string;
    locationName: string;
    receivedQuantity: number;
    defectQuantity: number;
  }): NotificationContent => ({
    type: 'PRODUCTION_DELIVERY_RECEIVED',
    title: 'Phiếu giao đã được nhận',
    description: `${args.locationName} đã nhận ${args.receivedQuantity} sản phẩm của phiếu ${args.deliveryCode} (${args.requestCode})${args.defectQuantity > 0 ? `, trong đó ${args.defectQuantity} lỗi` : ''}.`,
    link: `/workshop`,
  }),

  /** Phiếu giao bị hủy; gửi bên còn lại (xưởng nếu location từ chối, location nếu xưởng rút lại). */
  deliveryCancelled: (args: {
    deliveryCode: string;
    requestCode: string;
    byWorkshop: boolean;
    reason: string | null;
  }): NotificationContent => ({
    type: 'PRODUCTION_DELIVERY_CANCELLED',
    title: 'Phiếu giao đã bị hủy',
    description: `Phiếu ${args.deliveryCode} (${args.requestCode}) đã bị ${args.byWorkshop ? 'xưởng rút lại' : 'nơi nhận từ chối'}${args.reason ? `: ${args.reason}` : '.'}`,
    link: args.byWorkshop ? `/exchange/production-deliveries` : `/workshop`,
  }),

  /** Xưởng xác nhận đang làm YCSX; gửi người tạo YCSX và chủ shop. Từ lúc này shop không huỷ được YCSX. */
  workshopAccepted: (args: {
    requestCode: string;
    workshopName: string;
  }): NotificationContent => ({
    type: 'PRODUCTION_WORKSHOP_ACCEPTED',
    title: 'Xưởng đã nhận làm',
    description: `${args.workshopName} xác nhận đang làm ${args.requestCode}. Từ giờ chỉ xưởng huỷ được yêu cầu này.`,
    link: `/exchange/imports?source=WORKSHOP`,
  }),

  /** Xưởng huỷ YCSX. */
  workshopCancelled: (args: {
    requestCode: string;
    workshopName: string;
    reason: string;
  }): NotificationContent => ({
    type: 'PRODUCTION_WORKSHOP_CANCELLED',
    title: 'Xưởng đã huỷ yêu cầu sản xuất',
    description: `${args.workshopName} huỷ ${args.requestCode}: ${args.reason}`,
    link: `/exchange/imports?source=WORKSHOP`,
  }),
};
