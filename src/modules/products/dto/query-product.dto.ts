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

  /**
   * Không có mặc định (2026-10-23): POS, dialog đơn và bộ chọn combo đều tìm mọi loại qua route này,
   * nên mỗi màn tự nêu loại nó cần (`/products` gửi `PRODUCT,SERVICE`, `/combos` gửi `COMBO`).
   */
  @ProductTypesQuery()
  productType?: ProductType[];
}

export class QueryProductDto extends ProductFilterDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;
}

/** Tìm nhanh cho POS: một từ khoá khớp tên sản phẩm và mã / SKU / barcode của mọi phiên bản, trả kèm phiên bản. */
export class SearchProductDto extends ProductFilterDto {
  /** Một ký tự là đủ (2026-10-18), POS cần kết quả ngay từ chữ đầu. Trang đã giới hạn chi phí nên không cần ép 2 ký tự. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  q?: string;
}

/** Danh sách phẳng các phiên bản cho bộ chọn theo SKU, vì `GET /products` cố ý không gắn phiên bản. */
export class QueryProductItemDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Gắn tồn kho tại các chi nhánh này vào `stock` (0 nếu chưa có dòng). Không lọc danh sách, vì bộ chọn phải thấy cả hàng chi nhánh chưa từng có. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsUUID('4', { each: true })
  branchIds?: string[];

  /** `excludeDiscontinued=true` bỏ phiên bản của hàng đã ngừng, để `limit` chỉ đếm hàng chọn được. Bỏ trống = không lọc. */
  @BooleanQuery()
  excludeDiscontinued?: boolean;

  @ProductTypesQuery()
  productType?: ProductType[];

  // Không dùng PaginationQueryDto: đây là dropdown, không phải bảng nên không có trang, chỉ giữ mặc định và trần 200/500 như cũ.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
