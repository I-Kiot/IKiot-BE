import { BadRequestException } from '@nestjs/common';
import { FulfillmentType } from '../../common/constants/order-status';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  assertDeliveryInfoComplete,
  missingDeliveryFields,
} from './order-delivery.rules';

// Kiểm tra luật "đơn giao tận nơi phải đủ người nhận, SĐT, địa chỉ" (bug DEF-ST-09).
describe('missingDeliveryFields', () => {
  const complete = {
    recipientName: 'Nguyễn Văn A',
    recipientPhone: '0912345678',
    deliveryAddress: '1 Tràng Tiền, Hà Nội',
  };

  it('asks nothing of a complete home delivery', () => {
    expect(
      missingDeliveryFields(FulfillmentType.HOME_DELIVERY, complete),
    ).toEqual([]);
  });

  it('names every missing field of a home delivery', () => {
    expect(missingDeliveryFields(FulfillmentType.HOME_DELIVERY, {})).toEqual([
      'recipientName',
      'recipientPhone',
      'deliveryAddress',
    ]);
  });

  it('treats blank and null values as missing', () => {
    expect(
      missingDeliveryFields(FulfillmentType.HOME_DELIVERY, {
        ...complete,
        recipientName: '   ',
        deliveryAddress: null,
      }),
    ).toEqual(['recipientName', 'deliveryAddress']);
  });

  it('asks nothing of store pickup or a counter sale', () => {
    expect(missingDeliveryFields(FulfillmentType.STORE_PICKUP, {})).toEqual([]);
    expect(missingDeliveryFields(FulfillmentType.TAKEAWAY, {})).toEqual([]);
  });
});

describe('assertDeliveryInfoComplete', () => {
  it('throws ORDER_DELIVERY_INFO_REQUIRED with the missing fields', () => {
    let thrown: unknown;
    try {
      assertDeliveryInfoComplete(FulfillmentType.HOME_DELIVERY, {
        recipientName: 'A',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getResponse()).toMatchObject({
      code: ErrorCode.ORDER_DELIVERY_INFO_REQUIRED,
      errors: [{ field: 'recipientPhone' }, { field: 'deliveryAddress' }],
    });
  });
});
