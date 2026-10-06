import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { SUPPLIER_TYPES } from '../../../common/constants/inventory-ledger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QuerySupplierDto extends PaginationQueryDto {
  /** Partial, case-insensitive match on supplier name or phone number. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** `hasDebt=true` narrows the list to suppliers still owed money. */
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === true || value === 'true',
  )
  @IsBoolean()
  hasDebt?: boolean;

  /** `type=WORKSHOP` lists the workshops a production request can be sent to. */
  @IsOptional()
  @IsIn(SUPPLIER_TYPES)
  type?: string;
}
