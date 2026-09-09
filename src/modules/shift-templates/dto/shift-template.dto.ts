import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SHIFT_TIME_MESSAGE } from '../shift-time';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Ported from `ShiftTemplateDTO`; create and update take the same body, so a PATCH replaces every field rather than merging. `endTime` before `startTime` is deliberately allowed - a night shift is 22:00–06:00, and `WorkingScheduleService` reads that case to roll `endAt` onto the next day. */
export class ShiftTemplateDto {
  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Tên ca mẫu là bắt buộc' })
  name: string;

  @IsString()
  @trim()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: `Giờ bắt đầu: ${SHIFT_TIME_MESSAGE}`,
  })
  startTime: string;

  @IsString()
  @trim()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: `Giờ kết thúc: ${SHIFT_TIME_MESSAGE}`,
  })
  endTime: string;
}

export class QueryShiftTemplateDto extends PaginationQueryDto {
  /** Partial, case-insensitive match on the template's name. */
  @IsOptional()
  @IsString()
  @trim()
  name?: string;
}
