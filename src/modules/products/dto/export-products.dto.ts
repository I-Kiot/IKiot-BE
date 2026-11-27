import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ProductType } from '../../../common/constants/product-status';

/** Loại xuất được: combo không có dòng trong file nhập. */
export const EXPORTABLE_PRODUCT_TYPES = [
  ProductType.PRODUCT,
  ProductType.SERVICE,
] as const;

/** Body `POST /products/export`: hàng đã tích, bỏ trống là mọi hàng hoá của các loại đã chọn. */
export class ExportProductsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  ids?: string[];

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @IsIn(EXPORTABLE_PRODUCT_TYPES, {
    each: true,
    message: `productType phải là ${EXPORTABLE_PRODUCT_TYPES.join(', ')}`,
  })
  productType?: ProductType[];
}
