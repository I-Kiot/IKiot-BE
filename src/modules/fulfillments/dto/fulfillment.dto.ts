import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateFulfillmentDto {
  @IsUUID()
  orderId: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string; // YYYY-MM-DD
}

export class FulfillmentItemQtyDto {
  @IsUUID()
  orderItemId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  qtyPicked?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  qtyPacked?: number;
}

export class UpdateFulfillmentItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => FulfillmentItemQtyDto)
  items: FulfillmentItemQtyDto[];
}

export class CreatePackageDto {
  @IsOptional()
  @IsUUID()
  productPackageId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  weightKg?: number;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  photoUrls?: string[];
}

export class CancelFulfillmentDto {
  @IsOptional()
  @IsString()
  note?: string;
}
