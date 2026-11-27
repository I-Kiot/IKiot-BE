import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { QueryOrderDto } from './order.dto';
import {
  FULFILLMENT_TYPES,
  ORDER_CHANNELS,
  ORDER_PRIORITIES,
  REMITTANCE_STATUSES,
} from '../../../common/constants/order-status';
import {
  ORDER_ATTENTION_KINDS,
  ORDER_SORTS,
  type OrderAttentionKind,
  STOCK_CHECK_STATUSES,
  type OrderSort,
} from '../order-read.constants';

/** Query `GET /orders`: bộ lọc của quầy và của hành trình đơn. */
export class QueryOrderJourneyDto extends QueryOrderDto {
  @IsOptional()
  @IsIn(ORDER_CHANNELS)
  channel?: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsIn(ORDER_PRIORITIES)
  priority?: string;

  /** Hình thức giao: `STORE_PICKUP` cho màn hình “đơn chờ khách lấy”. */
  @IsOptional()
  @IsIn(FULFILLMENT_TYPES)
  fulfillmentType?: string;

  /** Dòng tệ nhất của đơn (lọc "đơn giao được ngay" = `ENOUGH`). Tính lúc đọc nên chỉ khớp đơn chưa giao. */
  @IsOptional()
  @IsIn(STOCK_CHECK_STATUSES)
  stockSummary?: string;

  /** Lọc theo tiền shipper thu đã nộp về chủ chưa. */
  @IsOptional()
  @IsIn(REMITTANCE_STATUSES)
  cashRemittanceStatus?: string;

  /** Khoảng ngày tạo; gửi cả hai cặp thì `from`/`to` thắng. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** `true` thì loại đơn bán tại quầy. */
  @BooleanQuery()
  excludePos?: boolean;

  @IsOptional()
  @IsIn(ORDER_SORTS)
  sort?: OrderSort;

  /** Lọc đơn cần chú ý: thiếu hàng, sắp tới ngày giao, khách lấy quá hạn. */
  @IsOptional()
  @IsIn(ORDER_ATTENTION_KINDS)
  attention?: OrderAttentionKind;
}
