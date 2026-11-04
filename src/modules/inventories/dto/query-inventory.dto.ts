import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
import { IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { LocationRefQueryDto } from '../../../common/dto/location-ref.dto';

/** Ghép bằng `IntersectionType` để luật "cái này kéo theo cái kia" chỉ nằm ở `LocationRefQueryDto`, không lệch nhau. */
export class QueryInventoryDto extends IntersectionType(
  PaginationQueryDto,
  LocationRefQueryDto,
) {
  /** Chỉ dòng ≤ `minStock` của chính nó, bỏ qua dòng đã tắt cảnh báo. */
  @BooleanQuery()
  isLowStock?: boolean;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;
}
