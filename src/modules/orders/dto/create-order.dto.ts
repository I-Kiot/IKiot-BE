import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  FulfillmentType,
  ORDER_PRIORITIES,
} from '../../../common/constants/order-status';
import { DEPOSIT_METHODS } from '../../../common/constants/payment-method';
import { AppliedPromotionDto } from './order.dto';
import { OrderItemCustomizationDto } from './order-item-customization.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** The order journey's two ways of getting goods to a customer. TAKEAWAY is the till's, and the till has its own route. */
export const JOURNEY_FULFILLMENT_TYPES: readonly string[] = [
  FulfillmentType.STORE_PICKUP,
  FulfillmentType.HOME_DELIVERY,
];

export const DepositType = {
  AMOUNT: 'AMOUNT',
  PERCENT: 'PERCENT',
} as const;

export type DepositType = (typeof DepositType)[keyof typeof DepositType];

export const DEPOSIT_TYPES: readonly string[] = Object.values(DepositType);

/** One line of a manual order. A COMBO variant is sent as itself; the server adds its components as child lines. */
export class CreateOrderItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @Min(1, { message: 'Số lượng phải từ 1 trở lên' })
  quantity: number;

  /** The price agreed with the customer - furniture is often haggled or quoted to measure. Omitted = the catalogue's `retailPrice`, which is also snapshotted as `listUnitPrice` either way. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Đơn giá không được âm' })
  unitPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền giảm không được âm' })
  discountAmount?: number;

  /** Where the goods are expected to ship from. Omitted = the branch's `defaultFulfillmentLocationId`, else the branch itself. */
  @IsOptional()
  @IsUUID()
  sourceLocationId?: string;

  /** Made to the customer's measure: the line gets a ProductItem of its own in the same transaction as the order (A-4). Later changes go through `PUT /orders/:id/items/:itemId/customization`. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderItemCustomizationDto)
  customization?: OrderItemCustomizationDto;
}

/** A customer typed in on the order form rather than picked from the list. Matched to an existing customer by phone first. */
export class InlineCustomerDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên khách hàng không được để trống' })
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  phone?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  address?: string;
}

/** Money taken when the order is created. Recorded as a `Payment { kind: DEPOSIT }`; the client never sends the amount still owed. */
export class OrderDepositDto {
  @IsIn(DEPOSIT_TYPES, {
    message: `deposit.type phải là ${DEPOSIT_TYPES.join(', ')}`,
  })
  type: DepositType;

  /** A sum in đồng for AMOUNT, a percentage of the grand total (0 < value ≤ 100) for PERCENT. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Tiền cọc không được âm' })
  value: number;

  @IsIn(DEPOSIT_METHODS, {
    message: `deposit.method phải là ${DEPOSIT_METHODS.join(', ')}`,
  })
  method: string;
}

/** `POST /orders` - a manual order from the order journey (contract §2), born CONFIRMED. Totals, the amount due, `status`, `channel`, `confirmedBy` and the order code are the server's. */
export class CreateOrderDto {
  @IsUUID()
  branchId: string;

  /** An existing customer. Wins over `customer` when both are sent. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InlineCustomerDto)
  customer?: InlineCustomerDto;

  /** Required - checked in the service so a missing one answers ORDER_ASSIGNEE_REQUIRED rather than a generic validation error. */
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsIn(JOURNEY_FULFILLMENT_TYPES, {
    message: `fulfillmentType phải là ${JOURNEY_FULFILLMENT_TYPES.join(', ')}`,
  })
  fulfillmentType: string;

  @IsOptional()
  @IsIn(ORDER_PRIORITIES, {
    message: `priority phải là ${ORDER_PRIORITIES.join(', ')}`,
  })
  priority?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Đơn hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Phí giao hàng không được âm' })
  shippingFee?: number;

  @IsOptional()
  @IsIn(['ORDER'], {
    message:
      'discountType chỉ nhận ORDER - giảm giá khuyến mãi do máy chủ tự tính từ appliedPromotions',
  })
  discountType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá trị giảm không được âm' })
  discountValue?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppliedPromotionDto)
  appliedPromotions?: AppliedPromotionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => OrderDepositDto)
  deposit?: OrderDepositDto;

  @IsOptional()
  @IsString()
  @Transform(trim)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  recipientPhone?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  deliveryAddress?: string;

  /** The date the customer asked for delivery (`YYYY-MM-DD`). */
  @IsOptional()
  @IsDateString()
  requestedDeliveryDate?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
