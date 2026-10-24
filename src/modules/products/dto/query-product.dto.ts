import { applyDecorators } from '@nestjs/common';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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

/** `?productType=PRODUCT,SERVICE` - one value or a comma list; omitted means every type. */
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

/** The filters `GET /products` and `GET /products/search` share. */
export class ProductFilterDto extends IntersectionType(
  PaginationQueryDto,
  LocationRefQueryDto,
) {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Products with at least one variant supplied by this supplier. */
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsIn(FILTERABLE_PRODUCT_STATUSES, {
    message: `status phải là ${FILTERABLE_PRODUCT_STATUSES.join(', ')}`,
  })
  status?: string;

  /** `isManufacturable=true` chỉ lấy sản phẩm đặt xưởng được - ô tìm hàng của form YCSX dùng nó. Bỏ trống = không lọc. */
  @BooleanQuery()
  isManufacturable?: boolean;

  /**
   * No default on purpose (2026-10-23): the till, the order dialogs and the combo picker search
   * every type through these routes, so each screen names the types it lists - `/products`
   * sends `PRODUCT,SERVICE`, `/combos` sends `COMBO`.
   */
  @ProductTypesQuery()
  productType?: ProductType[];
}

/** Ported from iKiotMS-BE's ProductQueryDTO. */
export class QueryProductDto extends ProductFilterDto {
  /** Partial, case-insensitive match on the product name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;
}

/** Ported from ProductSearchQueryDTO - the POS lookup, matching one term against the product name and every variant's code/SKU/barcode, with the variants returned inline. */
export class SearchProductDto extends ProductFilterDto {
  /** One character is enough (2026-10-18): the till wants results as soon as the first letter is typed. The old DTO demanded two because a one-character prefix matches much of the catalogue; the page size already caps the cost. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;
}

/** Ported from `listAllProductItems`: a flat list of variants for pickers that reference a specific SKU, since `GET /products` deliberately doesn't attach variants. */
export class QueryProductItemDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Attaches each variant's stock at these branches as `stock` (0 when the branch has no row yet). It does not narrow the list - a picker has to be able to reach goods the branch has never carried. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsUUID('4', { each: true })
  branchIds?: string[];

  /** `excludeDiscontinued=true` bỏ phiên bản của hàng đã ngừng kinh doanh - bộ chọn món combo dùng nó, để `limit` áp lên hàng chọn được. Bỏ trống = không lọc. */
  @BooleanQuery()
  excludeDiscontinued?: boolean;

  /** Variants of products of these types only; omitted = every type. */
  @ProductTypesQuery()
  productType?: ProductType[];

  // Not PaginationQueryDto: this feeds a dropdown, not a table - no page, just the same 200/500 default and cap the old service applied.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
