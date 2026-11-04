import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SHIPMENT_STATUSES } from '../../../common/constants/shipment-status';

const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `ACTIVE` là mọi trạng thái chưa kết thúc ("cần giao"); các giá trị còn lại là từng trạng thái. */
export const MY_HISTORY_ACTIVE = 'ACTIVE';

export class QueryMyHistoryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn([MY_HISTORY_ACTIVE, ...SHIPMENT_STATUSES], {
    message: 'Trạng thái giao hàng không hợp lệ',
  })
  status?: string;

  /** Ngày giao từ (gồm cả ngày này), `YYYY-MM-DD`, giờ Việt Nam. */
  @IsOptional()
  @Matches(LOCAL_DAY, { message: 'Ngày bắt đầu phải có dạng YYYY-MM-DD' })
  from?: string;

  /** Ngày giao tới (gồm cả ngày này), `YYYY-MM-DD`. */
  @IsOptional()
  @Matches(LOCAL_DAY, { message: 'Ngày kết thúc phải có dạng YYYY-MM-DD' })
  to?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100, { message: 'Từ khoá tối đa 100 ký tự' })
  search?: string;
}
