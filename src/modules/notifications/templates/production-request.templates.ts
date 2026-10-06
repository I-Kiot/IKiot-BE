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
};
