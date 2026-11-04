import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { SUPPLIER_TYPES } from '../../../common/constants/inventory-ledger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class QuerySupplierDto extends PaginationQueryDto {
  /** Khớp một phần, không phân biệt hoa thường, theo tên hoặc SĐT NCC. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;

  /** `hasDebt=true` chỉ lấy NCC còn nợ. */
  @BooleanQuery()
  hasDebt?: boolean;

  /** `type=WORKSHOP` liệt kê các thợ có thể nhận yêu cầu sản xuất. */
  @IsOptional()
  @IsIn(SUPPLIER_TYPES)
  type?: string;
}
