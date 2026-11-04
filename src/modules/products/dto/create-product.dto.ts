import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import {
  PRODUCT_TYPES,
  ProductType,
  SETTABLE_PRODUCT_STATUSES,
} from '../../../common/constants/product-status';
import {
  CreateProductItemDto,
  ProductAttributeDto,
  ProductImageDto,
} from './product-item.dto';

/** Port từ CreateProductRequestDTO. Không có `categoryName`: server tự điền từ `categoryId`, nhận từ client thì sản phẩm có thể gán nhầm danh mục. */
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

  /** Có đặt xưởng sản xuất được không. Bỏ trống = false (chỉ nhập từ NCC). */
  @IsOptional()
  @IsBoolean()
  isManufacturable?: boolean;

  /** PRODUCT (mặc định), COMBO hoặc SERVICE. Cố định lúc tạo; mọi phiên bản nhận `itemType` tương ứng. */
  @IsOptional()
  @IsIn(PRODUCT_TYPES, {
    message: `productType phải là ${PRODUCT_TYPES.join(', ')}`,
  })
  productType?: ProductType;

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

  /** Thuộc tính của sản phẩm kèm đơn vị (2026-10-16). Giá trị lấy từ `productDetails` của SKU đầu tiên. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeDto)
  attributes?: ProductAttributeDto[];

  // Sản phẩm không có phiên bản thì không có giá và không bán được, nên bị từ chối như API cũ.
  @IsArray()
  @ArrayNotEmpty({ message: 'Sản phẩm phải có ít nhất một mặt hàng' })
  @ValidateNested({ each: true })
  @Type(() => CreateProductItemDto)
  items: CreateProductItemDto[];
}
