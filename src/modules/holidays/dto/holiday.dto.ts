import { BooleanQuery } from '../../../common/decorators/boolean-query.decorator';
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

/** Phải là `YYYY-MM-DD` và là ngày tồn tại thật; `@Matches` một mình sẽ cho qua `2026-02-31`. */
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

/** PATCH: ngày và/hoặc tên. Cố ý không có `isActive`: bật/tắt là route riêng vì là quyết định riêng. */
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

  @BooleanQuery('isActive phải là true hoặc false')
  isActive?: boolean;

  @IsOptional()
  @IsIn(HOLIDAY_SOURCES, { message: 'Nguồn ngày lễ không hợp lệ' })
  source?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  name?: string;
}

export class SyncVietnamHolidayDto {
  @Type(() => Number)
  @IsInt({ message: 'year phải là số nguyên' })
  @Min(2000)
  // Service cũ giới hạn tới năm hiện tại + 5; hằng số này đủ gần và không đổi kết quả khi qua năm giữa lúc request.
  @Max(2100)
  year: number;
}
