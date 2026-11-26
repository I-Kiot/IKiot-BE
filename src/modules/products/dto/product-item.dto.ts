import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ProductItemType } from '../../../common/constants/product-status';

/** Một ảnh của sản phẩm hoặc phiên bản. Postgres tách thành bảng con, API vẫn giữ mảng object như cũ. */
export class ProductImageDto {
  @IsString()
  @IsNotEmpty({ message: 'Ảnh phải có url' })
  url: string;

  @IsOptional()
  @IsBoolean()
  isThumbnail?: boolean;
}

/** Một thuộc tính của sản phẩm; có `id` là sửa dòng cũ. */
export class ProductAttributeDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @IsNotEmpty({ message: 'Tên thuộc tính không được để trống' })
  name: string;

  @IsOptional()
  @IsString()
  unit?: string;
}

/** Một giá trị thuộc tính trên phiên bản (VD "Màu" / "Đỏ"). */
export class ProductItemDetailDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  value?: string;
}

/** Một thành phần combo. Thành phần có thể là COMBO khác (combo lồng nhau). */
/** Số lượng tối đa của một thành phần trong combo; FE cũng chặn đúng mức này. */
export const MAX_COMBO_COMPONENT_QUANTITY = 999;

export class ComboComponentDto {
  @IsUUID()
  componentItemId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Số lượng trong combo phải từ 1' })
  // Chặn trước cột int4, vì tràn số ở DB chỉ báo lỗi chung chung. 999 mỗi món là quá đủ cho một bộ.
  @Max(MAX_COMBO_COMPONENT_QUANTITY, {
    message: `Số lượng trong combo tối đa ${MAX_COMBO_COMPONENT_QUANTITY}`,
  })
  quantity: number;
}

/** Một phiên bản (ProductItem / SKU), port từ CreateProductItemRequestDTO. */
export class CreateProductItemDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên mặt hàng không được để trống' })
  productName: string;

  /** Bỏ trống thì service tự cấp mã `SP000001` theo tenant (từ 2026-09-12). */
  @IsOptional()
  @IsString()
  productCode?: string;

  /** Bỏ trống thì theo `productCode` (vẫn unique theo tenant). */
  @IsOptional()
  @IsString()
  sku?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá bán không được âm' })
  retailPrice: number;

  /** Bắt buộc với PRODUCT / SERVICE. COMBO bỏ qua: giá vốn là tổng thành phần, server tự tính. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá vốn không được âm' })
  costPrice?: number;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  warrantyPeriod?: string;

  /** Phần trăm, 0–100. API cũ ghi `VAT`, cột là `vat`. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100, { message: 'VAT phải trong khoảng 0–100' })
  vat?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductItemDetailDto)
  productDetails?: ProductItemDetailDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];

  /** NCC có thể mua phiên bản này. Mới so với API cũ (cũ chỉ gắn NCC sau khi tạo). */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  supplierIds?: string[];

  /** Không bắt buộc, server lấy theo `productType`; cố định lúc tạo. */
  @IsOptional()
  @IsIn(Object.values(ProductItemType), {
    message: `itemType phải là ${Object.values(ProductItemType).join(', ')}`,
  })
  itemType?: ProductItemType;

  /** Bắt buộc với COMBO, các loại khác bị từ chối. Cập nhật thì thay toàn bộ. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ComboComponentDto)
  comboComponents?: ComboComponentDto[];
}
