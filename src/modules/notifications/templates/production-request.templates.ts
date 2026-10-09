import type { NotificationContent } from '../notification-content.type';

/** The production list, filtered to one row - where every production notification points (contract §3). */
const listLink = (locationId: string | null, productItemId: string) => {
  const params = new URLSearchParams({ productItemId });
  if (locationId) params.set('locationId', locationId);
  return `/exchange/production-list?${params.toString()}`;
};

/** Notification copy for the workshop / production domain (hành trình GĐ1 – Bước 4). */
export const ProductionRequestNotificationTemplates = {
  /** A row just went from nothing short to short (edge-triggered, `crossedShortage`) - sent to whoever looks after that location. */
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

  /** Workshop goods arrived for a SKU some orders are waiting on - to the people in charge of those orders, so they can pack. */
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

  /** A workshop wrote a delivery note - to the receiving location's managers, who must count the goods and confirm before stock rises. */
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

  /** The location confirmed a delivery note - to the workshop's staff. */
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

  /** A delivery note was cancelled - to the other side (the workshop if the location refused it, the location if the workshop withdrew it). */
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
};
