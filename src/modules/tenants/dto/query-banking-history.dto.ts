import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** Query của `GET /tenant/banking/history`: chỉ phân trang. */
export class QueryBankingHistoryDto extends PaginationQueryDto {}
