import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SETTABLE_USER_STATUSES } from '../../../common/constants/user-status';

/** Bộ lọc của `getStaffList`, đổi tên cho nhất quán với các list khác (`recordPerPage` → `limit`, `keyword` → `search`). Bộ lọc `role` enum cũ nay là `roleId`, vì role là row do tenant định nghĩa. */
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
