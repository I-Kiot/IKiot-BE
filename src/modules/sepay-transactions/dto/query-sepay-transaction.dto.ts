import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { SepayTransactionOutcome } from '../../../common/constants/payment-method';

const OUTCOMES: readonly string[] = Object.values(SepayTransactionOutcome);

/** Query sổ giao dịch SePay. */
export class QuerySepayTransactionDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(OUTCOMES, { message: `outcome phải là ${OUTCOMES.join(', ')}` })
  outcome?: string;

  /** Chỉ giao dịch còn cần xử lý. */
  @BooleanQuery()
  unresolved?: boolean;

  /** Khoảng ngày giao dịch vào sổ (ISO). */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
