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
import { IMPORT_SOURCES } from '../../../common/constants/inventory-ledger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { MOVEMENT_STATUSES, MOVEMENT_TYPES } from '../stock-movement.constants';

/** Một dòng phiếu kho. */
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

/** Body tạo phiếu kho. */
export class CreateStockMovementDto {
  @IsIn(MOVEMENT_TYPES, {
    message: `movementType phải là ${MOVEMENT_TYPES.join(', ')}`,
  })
  movementType: string;

  @IsOptional()
  @IsUUID()
  fromSupplierId?: string;

  /** Nơi xuất hàng. */
  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  /** Nơi nhận hàng. */
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

/** Số thực nhận từng dòng. */
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

  /** Lọc theo nguồn nhập. */
  @IsOptional()
  @IsIn(IMPORT_SOURCES)
  importSource?: string;
}
