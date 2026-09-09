import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { SETTABLE_PRODUCT_STATUSES } from '../../../common/constants/product-status';
import { CreateProductItemDto, ProductImageDto } from './product-item.dto';

/** Ported from CreateProductRequestDTO. `categoryName` is deliberately absent: it is a denormalized copy the server fills in from `categoryId`, and taking it from the client let a product claim a category it wasn't in. */
export class CreateProductDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên sản phẩm không được để trống' })
  name: string;

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

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];

  // A product with no variants has no price and nothing sellable, so it is rejected as the old API rejected it.
  @IsArray()
  @ArrayNotEmpty({ message: 'Sản phẩm phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => CreateProductItemDto)
  items: CreateProductItemDto[];
}
