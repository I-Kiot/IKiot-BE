import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryCategoryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Lọc theo cha. Chuỗi `parentId=null` nghĩa là chỉ lấy cấp gốc (API cũ hỗ trợ, bộ chọn danh mục đang dựa vào); bỏ trống thì không lọc. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'null' ? null : value,
  )
  @IsString()
  parentId?: string | null;
}
