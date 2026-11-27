import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SupplierDebtEntryType } from '../../../common/constants/supplier-debt';

const TYPES: readonly string[] = Object.values(SupplierDebtEntryType);

/** Query của `GET /suppliers/:id/debt-entries`. */
export class QuerySupplierDebtEntryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TYPES, { message: `entryType phải là ${TYPES.join(', ')}` })
  entryType?: string;
}
