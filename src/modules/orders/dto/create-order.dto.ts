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

/** Hai cách giao hàng của hành trình đơn. TAKEAWAY thuộc quầy thu ngân, quầy có route riêng. */
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

/** Một dòng đơn tay. Combo gửi đúng như chính nó; server tự thêm các thành phần thành dòng con. */
export class CreateOrderItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @Min(1, { message: 'Số lượng phải từ 1 trở lên' })
  quantity: number;

  /** Giá thoả thuận với khách, bỏ trống thì lấy giá bán lẻ. */
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

  /** Kho xuất hàng, bỏ trống thì lấy kho mặc định của chi nhánh. */
  @IsOptional()
  @IsUUID()
  sourceLocationId?: string;

  /** Thông số may theo số đo, tạo SKU riêng cho dòng. */
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderItemCustomizationDto)
  customization?: OrderItemCustomizationDto;
}

/** Khách nhập tay trên form, không chọn từ danh sách. Khớp khách có sẵn theo số điện thoại trước. */
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

/** Tiền thu lúc tạo đơn, ghi thành `Payment { kind: DEPOSIT }`. Client không gửi số còn nợ. */
export class OrderDepositDto {
  @IsIn(DEPOSIT_TYPES, {
    message: `deposit.type phải là ${DEPOSIT_TYPES.join(', ')}`,
  })
  type: DepositType;

  /** AMOUNT: số tiền đồng. PERCENT: % tổng đơn (0 < value ≤ 100). */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Tiền cọc không được âm' })
  value: number;

  @IsIn(DEPOSIT_METHODS, {
    message: `deposit.method phải là ${DEPOSIT_METHODS.join(', ')}`,
  })
  method: string;
}

/** Body `POST /orders`: tạo đơn tay ở trạng thái CONFIRMED. */
export class CreateOrderDto {
  @IsUUID()
  branchId: string;

  /** Khách có sẵn. Thắng `customer` nếu gửi cả hai. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InlineCustomerDto)
  customer?: InlineCustomerDto;

  /** Người phụ trách, bắt buộc (kiểm trong service để trả mã lỗi riêng). */
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

  /** Ngày khách muốn giao (`YYYY-MM-DD`). */
  @IsOptional()
  @IsDateString()
  requestedDeliveryDate?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
