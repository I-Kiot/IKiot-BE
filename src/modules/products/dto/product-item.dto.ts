import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One image on a product or a variant; Mongo stored these inline and Postgres splits them into a child table, but the API keeps the same array of objects. */
export class ProductImageDto {
  @IsString()
  @IsNotEmpty({ message: 'Ảnh phải có url' })
  url: string;

  @IsOptional()
  @IsBoolean()
  isThumbnail?: boolean;
}

/** One spec row on a variant ("Màu" / "Đỏ"). `productDetails` in the old API. */
export class ProductItemDetailDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  value?: string;
}

/** A variant (ProductItem / SKU), ported from CreateProductItemRequestDTO - which the old code also duplicated by hand inside CreateProductRequestDTO, where the two had already diverged. */
export class CreateProductItemDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên mặt hàng không được để trống' })
  productName: string;

  @IsString()
  @IsNotEmpty({ message: 'Mã mặt hàng không được để trống' })
  productCode: string;

  @IsString()
  @IsNotEmpty({ message: 'SKU không được để trống' })
  sku: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá bán không được âm' })
  retailPrice: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Giá vốn không được âm' })
  costPrice: number;

  @IsOptional()
  @IsString()
  barcode?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  warrantyPeriod?: string;

  /** Percent, 0–100. Spelled `VAT` in the old API; the column is `vat`. */
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

  /** Suppliers this variant can be bought from. New here: the old API only allowed attaching a supplier afterwards. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  supplierIds?: string[];
}
