import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { SepayTransactionOutcome } from '../../../common/constants/payment-method';

const OUTCOMES: readonly string[] = Object.values(SepayTransactionOutcome);

/** Query của `GET /sepay-transactions`: danh sách ngoại lệ của sổ SePay (tiền về chưa chốt, chốt thiếu, trả dư, không gắn được đơn). */
export class QuerySepayTransactionDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(OUTCOMES, { message: `outcome phải là ${OUTCOMES.join(', ')}` })
  outcome?: string;

  /** `true`: chỉ những dòng còn việc phải làm (chưa xử lý và là REJECTED, UNMATCHED, SETTLED_PARTIAL hay có tiền dư). */
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
