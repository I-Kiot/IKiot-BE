import { applyDecorators } from '@nestjs/common';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { LocationRefQueryDto } from '../../../common/dto/location-ref.dto';
import {
  FILTERABLE_PRODUCT_STATUSES,
  PRODUCT_TYPES,
  ProductType,
} from '../../../common/constants/product-status';

/** `?productType=PRODUCT,SERVICE`, một giá trị hoặc danh sách phẩy. Bỏ trống = mọi loại. */
function ProductTypesQuery(): PropertyDecorator {
  return applyDecorators(
    IsOptional(),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.split(',').filter(Boolean) : value,
    ),
    IsIn(PRODUCT_TYPES, {
      each: true,
      message: `productType phải là ${PRODUCT_TYPES.join(', ')}`,
    }),
  );
}

export class ProductFilterDto extends IntersectionType(
  PaginationQueryDto,
  LocationRefQueryDto,
) {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsIn(FILTERABLE_PRODUCT_STATUSES, {
    message: `status phải là ${FILTERABLE_PRODUCT_STATUSES.join(', ')}`,
  })
  status?: string;

  /** `isManufacturable=true` chỉ lấy hàng đặt xưởng được (ô tìm của form YCSX). Bỏ trống = không lọc. */
  @BooleanQuery()
  isManufacturable?: boolean;

  /** Lọc theo loại sản phẩm, không có mặc định. */
  @ProductTypesQuery()
  productType?: ProductType[];
}

export class QueryProductDto extends ProductFilterDto {
  /** Chỉ sản phẩm có lô hỏng còn hàng tại địa điểm đang chọn. */
  @BooleanQuery()
  hasDamaged?: boolean;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;
}

/** Từ khoá tìm nhanh cho POS: tên, mã, SKU, barcode. */
export class SearchProductDto extends ProductFilterDto {
  /** Tối thiểu một ký tự. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;

  /** Chỉ lấy sản phẩm chứa các phiên bản này (tối đa 100). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  itemIds?: string[];
}

/** Danh sách phẳng các phiên bản cho bộ chọn theo SKU, vì `GET /products` cố ý không gắn phiên bản. */
export class QueryProductItemDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Gắn tồn tại các chi nhánh này, không lọc danh sách. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsUUID('4', { each: true })
  branchIds?: string[];

  /** Bỏ phiên bản của hàng đã ngừng bán. */
  @BooleanQuery()
  excludeDiscontinued?: boolean;

  @ProductTypesQuery()
  productType?: ProductType[];

  // Danh sách cho dropdown, không phân trang.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
