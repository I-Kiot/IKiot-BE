import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PAYMENT_METHODS } from '../../../common/constants/payment-method';
import {
  OFFLINE_PAYMENT_METHODS,
  ORDER_STATUSES,
  SETTABLE_ORDER_STATUSES,
} from '../order.constants';

export class OrderItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'Số lượng phải từ 1 trở lên' })
  quantity: number;

  // Không có `unitPrice`: giá bán là của danh mục, không phải của quầy. Xem `OrderService.priceLines`.

  /** Giảm tay trên dòng này, bị bỏ qua khi đơn có `appliedPromotions`: server tự tính khuyến mãi và ghi đè mọi dòng nên hai cách không trộn được. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền giảm không được âm' })
  discountAmount?: number;
}

/** Khuyến mãi được chọn, chỉ gửi id: tên và số tiền giảm do server tính. Gửi `promoName`/`discountAmount` cũ cũng không sao vì `whitelist: true` bỏ chúng. */
export class AppliedPromotionDto {
  @IsUUID()
  promotionId: string;
}

/** Bán tại quầy (`POST /orders/pos`). Không nhận `grandTotal` từ client: API cũ lưu tổng client gửi nên request giả có thể làm giỏ bằng 0. `status`, `change`, `paymentReference` cũng bỏ vì lý do đó. */
export class CreatePosOrderDto {
  @IsUUID()
  branchId: string;

  /** Bỏ trống = khách vãng lai, tạo một lần cho mỗi tenant khi dùng lần đầu. */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsIn(PAYMENT_METHODS, {
    message: `paymentMethod phải là ${PAYMENT_METHODS.join(', ')}`,
  })
  paymentMethod: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Đơn hàng phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  customerPay?: number;

  @IsOptional()
  @IsString()
  note?: string;

  /** `ORDER`: giảm tay cả đơn. `PROMOTION` không nhận từ client: gửi `appliedPromotions` là đủ để thành đơn khuyến mãi, server tự đặt cả hai trường theo kết quả engine. */
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
}

export class QueryOrderDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @IsOptional()
  @IsDateString()
  toDate?: string;
}

export class UpdateOrderStatusDto {
  @IsIn(SETTABLE_ORDER_STATUSES, {
    message: `status phải là ${SETTABLE_ORDER_STATUSES.join(', ')}`,
  })
  status: string;
}

/** Chốt đơn SePay mà khách đã trả bằng cách khác. */
export class PayOfflineOrderDto {
  @IsOptional()
  @IsIn(OFFLINE_PAYMENT_METHODS, {
    message: `paymentMethod phải là ${OFFLINE_PAYMENT_METHODS.join(', ')}`,
  })
  paymentMethod?: string = 'CASH';

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số tiền khách đưa không được âm' })
  customerPay?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
