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
import { LocationRefDto } from '../../../common/dto/location-ref.dto';
import { MOVEMENT_STATUSES, MOVEMENT_TYPES } from '../stock-movement.constants';

/** One line of a movement. Which fields are required depends on the movement type and the service enforces that: `quantity` is optional because an ADJUST line may mean "use what the system thinks", `importPrice` because EXPORT/RETURN falls back to cost price. */
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

  /** What was actually counted or actually arrived. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số lượng thực nhận không được âm' })
  receivedQuantity?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Ported from the payload StockMovementController accepted; `status` is the state machine's business and `totalPrice` is computed from the lines. */
export class CreateStockMovementDto {
  @IsIn(MOVEMENT_TYPES, {
    message: `movementType phải là ${MOVEMENT_TYPES.join(', ')}`,
  })
  movementType: string;

  /** IMPORT only - who the goods are coming from. */
  @IsOptional()
  @IsUUID()
  fromSupplierId?: string;

  /** Where stock leaves from - required for EXPORT/RETURN/ADJUST. A STAFF account may omit it and have their posting filled in; a TENANT_OWNER has to say. */
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationRefDto)
  fromLocation?: LocationRefDto;

  /** Where stock arrives. Required for IMPORT/EXPORT/RETURN, meaningless for ADJUST. */
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationRefDto)
  toLocation?: LocationRefDto;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Phiếu phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => MovementItemDto)
  details: MovementItemDto[];
}

/** Replaces the whole line set. */
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
