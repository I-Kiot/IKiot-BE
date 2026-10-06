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

/** Body of POST /order-returns (D-5, contract §5). Who opens it comes from the token. */
export class CreateOrderReturnDto {
  @IsUUID()
  orderId: string;

  @IsIn(ORDER_RETURN_REASONS, {
    message: `reason phải là ${ORDER_RETURN_REASONS.join(', ')}`,
  })
  reason: string;

  /** The failed delivery, when that is why the goods came back. */
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

  /** Null / missing is refused with ORDER_RETURN_CONDITION_REQUIRED, so the service can name every line that lacks it. */
  @IsOptional()
  @IsIn(RETURN_CONDITIONS, {
    message: `condition phải là ${RETURN_CONDITIONS.join(', ')}`,
  })
  condition?: string;

  /** GOOD only: where the goods are put back. Defaults to the location they left, which must sell. */
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

export class QueryOrderReturnDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ORDER_RETURN_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  /** Return code, order code or customer name / phone. */
  @IsOptional()
  @IsString()
  search?: string;
}
