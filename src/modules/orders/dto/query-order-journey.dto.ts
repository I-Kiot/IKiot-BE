import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { QueryOrderDto } from './order.dto';
import {
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

/** Query của `GET /orders`. Giữ nguyên bộ lọc của quầy vì POS vẫn liệt kê qua route này, thêm bộ lọc hành trình đơn. `search` giờ khớp cả mã đơn. */
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

  /** Dòng tệ nhất của đơn (lọc "đơn giao được ngay" = `ENOUGH`). Tính lúc đọc nên chỉ khớp đơn chưa giao. */
  @IsOptional()
  @IsIn(STOCK_CHECK_STATUSES)
  stockSummary?: string;

  /** Tiền shipper thu đã về tay chủ chưa, đọc từ Payment BALANCE. `NOT_APPLICABLE` cũng khớp đơn không có BALANCE. */
  @IsOptional()
  @IsIn(REMITTANCE_STATUSES)
  cashRemittanceStatus?: string;

  /** Tên theo contract cho khoảng ngày tạo; `fromDate`/`toDate` kế thừa từ quầy là cùng ý. Gửi cả hai thì `from`/`to` thắng. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** `true` loại đơn bán tại quầy (`TAKEAWAY`). Màn hình hành trình gửi `true`, POS thì không nên đây là tùy chọn chứ không luôn bật như contract (quyết định 2026-10-06, A-8). */
  @BooleanQuery()
  excludePos?: boolean;

  @IsOptional()
  @IsIn(ORDER_SORTS)
  sort?: OrderSort;

  /** Đơn cần chú ý: `SHORT` (có dòng thiếu một phần hoặc hết trên kệ), `DUE_SOON` (gần hoặc quá ngày giao). Chỉ đơn chưa giao mới khớp. */
  @IsOptional()
  @IsIn(ORDER_ATTENTION_KINDS)
  attention?: OrderAttentionKind;
}
