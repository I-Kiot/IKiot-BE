import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { REFUND_METHODS } from '../../../common/constants/payment-method';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  ORDER_RETURN_REASONS,
  ORDER_RETURN_STATUSES,
  RETURN_CONDITIONS,
} from '../../../common/constants/return-status';

export class CreateOrderReturnItemDto {
  @IsUUID()
  orderItemId: string;

  @IsInt()
  @Min(1, { message: 'Số lượng hoàn phải lớn hơn 0' })
  quantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Người mở đơn hoàn lấy từ token (D-5, contract §5). */
export class CreateOrderReturnDto {
  @IsUUID()
  orderId: string;

  @IsIn(ORDER_RETURN_REASONS, {
    message: `reason phải là ${ORDER_RETURN_REASONS.join(', ')}`,
  })
  reason: string;

  /** Lần giao thất bại, nếu hàng về vì lý do đó. */
  @IsOptional()
  @IsUUID()
  shipmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Đơn hoàn phải có ít nhất một dòng hàng' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderReturnItemDto)
  items: CreateOrderReturnItemDto[];
}

export class InspectOrderReturnItemDto {
  @IsUUID()
  orderItemId: string;

  /** Thiếu hoặc null thì bị từ chối bằng ORDER_RETURN_CONDITION_REQUIRED, để service chỉ ra được mọi dòng thiếu. */
  @IsOptional()
  @IsIn(RETURN_CONDITIONS, {
    message: `condition phải là ${RETURN_CONDITIONS.join(', ')}`,
  })
  condition?: string;

  /** Chỉ cho GOOD: hàng được đưa về đâu. Mặc định là nơi hàng xuất, nơi này phải bán được. */
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Hoàn tiền cho khách lúc kiểm hàng trả. `amount: 0` là shop giữ lại toàn bộ (không ghi tiền). */
export class ReturnRefundDto {
  @IsInt()
  @Min(0, { message: 'Số tiền hoàn không được âm' })
  amount: number;

  /** Bắt buộc khi `amount > 0`. Tiền mặt ra khỏi quỹ của chi nhánh bán đơn; chuyển khoản là tiền ra ngân hàng. */
  @ValidateIf((o: ReturnRefundDto) => o.amount > 0)
  @IsIn(REFUND_METHODS, {
    message: `method phải là ${REFUND_METHODS.join(', ')}`,
  })
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class InspectOrderReturnDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectOrderReturnItemDto)
  items: InspectOrderReturnItemDto[];

  /** Bắt buộc khi đơn đang giữ tiền (ORDER_RETURN_REFUND_REQUIRED); không giữ gì thì bỏ qua. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ReturnRefundDto)
  refund?: ReturnRefundDto;
}

/** Hàng của lần giao thất bại đã về shop (confirm-failed-delivery). */
export class ConfirmFailedDeliveryDto {
  @IsUUID()
  shipmentId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Kết luận từng dòng; dòng bỏ sót (hoặc cả danh sách) thì về GOOD tại nơi đã xuất. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InspectOrderReturnItemDto)
  items?: InspectOrderReturnItemDto[];

  /** Không bắt buộc ở đây (hàng chưa tới tay khách): bỏ qua nghĩa là tiền cọc vẫn do shop giữ. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ReturnRefundDto)
  refund?: ReturnRefundDto;
}

export class QueryOrderReturnDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ORDER_RETURN_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
