import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ORDER_EVENT_TYPES } from '../../../common/constants/order-event-type';

export class QueryOrderActivityDto {
  /** Tên người thao tác (khớp một phần). */
  @IsOptional()
  @IsString()
  actor?: string;

  @IsOptional()
  @IsIn(ORDER_EVENT_TYPES, { message: 'Loại thao tác không hợp lệ' })
  type?: string;

  /** Mã đơn (khớp một phần). */
  @IsOptional()
  @IsString()
  orderCode?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
