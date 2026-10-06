import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { QueryOrderDto } from './order.dto';
import {
  ORDER_CHANNELS,
  ORDER_PRIORITIES,
  REMITTANCE_STATUSES,
} from '../../../common/constants/order-status';
import {
  ORDER_SORTS,
  STOCK_CHECK_STATUSES,
  type OrderSort,
} from '../order-read.constants';

/** `GET /orders` query (A-9, contract §2): the till's own filters, inherited unchanged because POS still lists through this route, plus the order-journey ones. `search` now also matches the order code. */
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

  /** The order's worst line - lets the list show "orders that can go now" (`ENOUGH`). Worked out when read, so it only ever matches orders that have not shipped. */
  @IsOptional()
  @IsIn(STOCK_CHECK_STATUSES)
  stockSummary?: string;

  /** Has the cash a shipper collected reached the owner - read off the order's BALANCE payment. `NOT_APPLICABLE` also matches orders that have none. */
  @IsOptional()
  @IsIn(REMITTANCE_STATUSES)
  cashRemittanceStatus?: string;

  /** Contract name for the creation-date window; the inherited `fromDate`/`toDate` are the till's spelling of the same thing. When both are sent, `from`/`to` win. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** `true` leaves out the till's sales (`TAKEAWAY`): the order-journey screens send it, POS does not - both list through this route, so it is opt-in rather than the contract's "always" (decided 2026-10-06, A-8). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  excludePos?: boolean;

  /** Defaults to `createdAt`. */
  @IsOptional()
  @IsIn(ORDER_SORTS)
  sort?: OrderSort;
}
