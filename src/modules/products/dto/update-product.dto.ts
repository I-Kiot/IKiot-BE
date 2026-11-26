import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { SETTABLE_PRODUCT_STATUSES } from '../../../common/constants/product-status';
import { ProductAttributeDto, ProductImageDto } from './product-item.dto';

/** Body sửa sản phẩm; ngừng bán chỉ qua DELETE. */
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

  // Tắt cờ không ảnh hưởng YCSX đang mở (dòng đã đặt vẫn nhận hàng), chỉ chặn dòng mới.
  @IsOptional()
  @IsBoolean()
  isManufacturable?: boolean;

  @IsOptional()
  @IsIn(SETTABLE_PRODUCT_STATUSES, {
    message: `status phải là ${SETTABLE_PRODUCT_STATUSES.join(' hoặc ')}`,
  })
  status?: string;

  /** Thay toàn bộ thuộc tính: giữ dòng có `id`, xoá dòng vắng mặt. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeDto)
  attributes?: ProductAttributeDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];
}
