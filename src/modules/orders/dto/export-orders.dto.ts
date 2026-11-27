import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';
import { QueryOrderJourneyDto } from './query-order-journey.dto';

/** Query `GET /orders/export`: cùng bộ lọc với danh sách, bỏ phân trang; `ids` là các đơn đã tích. */
export class ExportOrdersDto extends QueryOrderJourneyDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids?: string[];
}
