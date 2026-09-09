import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { SETTABLE_PRODUCT_STATUSES } from '../../../common/constants/product-status';
import { ProductImageDto } from './product-item.dto';

/** Ported from UpdateProductRequestDTO, not `PartialType(CreateProductDto)`: `items` is never edited here, and DISCONTINUED is reachable only through DELETE /products/:id, which checks stock and pending paperwork first. */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  name?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(SETTABLE_PRODUCT_STATUSES, {
    message: `status phải là ${SETTABLE_PRODUCT_STATUSES.join(' hoặc ')}`,
  })
  status?: string;

  // Replaces the whole set when given, same as the old API's behaviour.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];
}
