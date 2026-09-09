import { IntersectionType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { LocationRefQueryDto } from '../../../common/dto/location-ref.dto';

/** Ported from InventoryQueryDTO, composed with `IntersectionType` so the "one implies the other" rule stays in `LocationRefQueryDto` and the two can't drift. */
export class QueryInventoryDto extends IntersectionType(
  PaginationQueryDto,
  LocationRefQueryDto,
) {
  /** Only lines at or below their own `minStock`, ignoring lines with the alert off. */
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  @IsBoolean()
  isLowStock?: boolean;

  /** Partial, case-insensitive match on the variant's SKU or product name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  search?: string;
}
