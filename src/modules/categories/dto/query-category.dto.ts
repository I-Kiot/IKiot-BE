import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QueryCategoryDto extends PaginationQueryDto {
  /** Partial, case-insensitive match on the category name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** Filter by parent. The literal string `parentId=null` means "top-level only" - the old API supported it and the category picker relies on it; left undefined the filter is not applied. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'null' ? null : value,
  )
  @IsString()
  parentId?: string | null;
}
