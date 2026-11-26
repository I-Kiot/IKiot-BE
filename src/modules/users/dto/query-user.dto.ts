import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SETTABLE_USER_STATUSES } from '../../../common/constants/user-status';

/** Bộ lọc danh sách nhân viên. */
export class QueryUserDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  // Không có DELETED là chủ đích: nhân viên đã xoá bị ẩn danh và không bao giờ hiện trong danh sách.
  @IsOptional()
  @IsIn(SETTABLE_USER_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}
