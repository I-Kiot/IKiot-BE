import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SETTABLE_USER_STATUSES } from '../../../common/constants/user-status';

/** Ported from the filters `getStaffList` accepted, with two renames for consistency with every other list endpoint (`recordPerPage` → `limit`, `keyword` → `search`); the old fixed-enum `role` filter is `roleId`, since roles are tenant-defined rows now. */
export class QueryUserDto extends PaginationQueryDto {
  /** Partial, case-insensitive match on email, phone number, first or last name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  // DELETED is absent on purpose: deleted staff are anonymised and never listed.
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
