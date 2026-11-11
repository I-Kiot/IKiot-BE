import { IsIn, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { PriceChangeField } from '../../../common/constants/price-change';

const FIELDS: readonly string[] = Object.values(PriceChangeField);

/** Query của `GET /products/items/:itemId/price-history`. */
export class QueryPriceHistoryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(FIELDS, { message: `field phải là ${FIELDS.join(', ')}` })
  field?: string;
}
