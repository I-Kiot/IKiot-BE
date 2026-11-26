import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { FILTERABLE_LOCATION_STATUSES } from '../../../common/constants/location-status';

/** Bộ lọc danh sách chi nhánh và kho. */
export class QueryLocationDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  // Bỏ trống = mọi thứ chưa xoá mềm; status=DELETED để xem thùng rác, như API cũ.
  @IsOptional()
  @IsIn(FILTERABLE_LOCATION_STATUSES)
  status?: string;
}
