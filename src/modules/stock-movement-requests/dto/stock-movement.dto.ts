import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { MOVEMENT_STATUSES, MOVEMENT_TYPES } from '../stock-movement.constants';

/** Một dòng phiếu. Trường bắt buộc tuỳ loại phiếu, service kiểm: `quantity` không bắt buộc với ADJUST (dùng số hệ thống), `importPrice` với EXPORT/RETURN lấy giá vốn. */
export class MovementItemDto {
  @IsUUID()
  productItemId: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số lượng không được âm' })
  quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Đơn giá nhập không được âm' })
  importPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số lượng thực nhận không được âm' })
  receivedQuantity?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Port từ payload StockMovementController nhận. `status` do state machine quyết, `totalPrice` tính từ dòng. */
export class CreateStockMovementDto {
  @IsIn(MOVEMENT_TYPES, {
    message: `movementType phải là ${MOVEMENT_TYPES.join(', ')}`,
  })
  movementType: string;

  @IsOptional()
  @IsUUID()
  fromSupplierId?: string;

  /** Hàng xuất từ đâu, bắt buộc với EXPORT/RETURN/ADJUST. STAFF có thể bỏ trống để dùng nơi phân công; TENANT_OWNER phải ghi. */
  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  /** Hàng về đâu, bắt buộc với IMPORT/EXPORT/RETURN, vô nghĩa với ADJUST. Chỉ nhận id: loại địa điểm đọc từ dòng Location, không lấy từ client. */
  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Phiếu phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => MovementItemDto)
  details: MovementItemDto[];
}

export class UpdateMovementDetailsDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Phiếu phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => MovementItemDto)
  details: MovementItemDto[];
}

/** What actually turned up, line by line. Every line of the request must be accounted for. */
export class ReceiveMovementItemDto {
  @IsUUID()
  productItemId: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số lượng thực nhận không được âm' })
  receivedQuantity: number;
}

export class ReceiveMovementDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Cần khai báo số lượng thực nhận' })
  @ValidateNested({ each: true })
  @Type(() => ReceiveMovementItemDto)
  details: ReceiveMovementItemDto[];
}

export class QueryStockMovementDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(MOVEMENT_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  movementType?: string;
}
