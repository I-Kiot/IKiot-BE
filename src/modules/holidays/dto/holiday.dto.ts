import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { HOLIDAY_SOURCES } from '../holiday.constants';

/** `YYYY-MM-DD`, and a date that actually exists - `@Matches` alone would let `2026-02-31` through, so the old DTO round-tripped it through `Date`. */
export const HOLIDAY_DATE_MESSAGE =
  'A holiday date must be formatted YYYY-MM-DD and be a real date';

export function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

class HolidayDateDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/, {
    message: HOLIDAY_DATE_MESSAGE,
  })
  date: string;
}

export class CreateHolidayDto extends HolidayDateDto {
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'Tên ngày lễ là bắt buộc' })
  name: string;

  @IsOptional()
  @IsBoolean({ message: 'isActive phải là boolean' })
  isActive?: boolean = true;
}

/** `PATCH /holidays/:id` - date and/or name. `isActive` is deliberately absent: turning a holiday off is its own route because it is its own decision. */
export class UpdateHolidayDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/, {
    message: HOLIDAY_DATE_MESSAGE,
  })
  date?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'Tên ngày lễ không được để trống' })
  name?: string;
}

export class ToggleHolidayStatusDto {
  @IsBoolean({ message: 'isActive là bắt buộc và phải là boolean' })
  isActive: boolean;
}

export class QueryHolidayDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000, { message: 'year phải từ 2000 đến 2100' })
  @Max(2100, { message: 'year phải từ 2000 đến 2100' })
  year?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean({ message: 'isActive phải là true hoặc false' })
  isActive?: boolean;

  @IsOptional()
  @IsIn(HOLIDAY_SOURCES, { message: 'Nguồn ngày lễ không hợp lệ' })
  source?: string;

  /** Partial, case-insensitive match on the holiday's name. */
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;
}

/** `POST /holidays/sync/vietnam`. */
export class SyncVietnamHolidayDto {
  @Type(() => Number)
  @IsInt({ message: 'year phải là số nguyên' })
  @Min(2000)
  // The old DTO capped at "current year + 5"; a constant is close enough and doesn't change answer as the clock rolls over mid-request.
  @Max(2100)
  year: number;
}
