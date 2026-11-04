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
  ValidateNested,
} from 'class-validator';
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

export class InspectOrderReturnDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectOrderReturnItemDto)
  items: InspectOrderReturnItemDto[];
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
