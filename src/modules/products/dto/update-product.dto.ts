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

/** Port từ UpdateProductRequestDTO, không dùng `PartialType(CreateProductDto)`: `items` không sửa ở đây, và DISCONTINUED chỉ qua DELETE /products/:id (kiểm tồn kho và phiếu đang chờ trước). */
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

  /** Khi có, thay toàn bộ thuộc tính: dòng có `id` được giữ (đổi tên), dòng vắng mặt bị xoá kèm giá trị trên mọi SKU. */
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
