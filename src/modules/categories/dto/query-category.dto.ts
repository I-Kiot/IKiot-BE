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

  /** Lọc theo cha; `null` là chỉ cấp gốc. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'null' ? null : value,
  )
  @IsString()
  parentId?: string | null;
}
