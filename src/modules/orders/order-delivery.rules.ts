import { BadRequestException } from '@nestjs/common';
import { FulfillmentType } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';

// Quy tắc thông tin giao hàng dùng chung cho tạo và sửa đơn.

/** Ba thông tin người giao cần để mang hàng tới khách. */
export interface DeliveryInfo {
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryAddress?: string | null;
}

export type DeliveryField = keyof DeliveryInfo;

/** Các trường giao hàng còn thiếu. Chỉ đơn giao tận nơi mới cần; chuỗi toàn khoảng trắng tính là thiếu. */
export function missingDeliveryFields(
  fulfillmentType: string,
  info: DeliveryInfo,
): DeliveryField[] {
  if (fulfillmentType !== FulfillmentType.HOME_DELIVERY) return [];
  const fields: DeliveryField[] = [
    'recipientName',
    'recipientPhone',
    'deliveryAddress',
  ];
  return fields.filter((field) => {
    const value = info[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** Từ chối đơn giao tận nơi thiếu người nhận, số điện thoại hoặc địa chỉ, nêu đúng các trường thiếu. */
export function assertDeliveryInfoComplete(
  fulfillmentType: string,
  info: DeliveryInfo,
): void {
  const missing = missingDeliveryFields(fulfillmentType, info);
  if (missing.length > 0) {
    throw new BadRequestException({
      code: ErrorCode.ORDER_DELIVERY_INFO_REQUIRED,
      message: `A home delivery order needs ${missing.join(', ')}`,
      errors: missing.map((field) => ({ field })),
    });
  }
}
