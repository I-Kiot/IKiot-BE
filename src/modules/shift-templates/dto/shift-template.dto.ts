import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { SHIFT_TIME_MESSAGE } from '../shift-time';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** Body ca mẫu; giờ kết thúc trước giờ bắt đầu là ca đêm. */
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
  @IsOptional()
  @IsString()
  @trim()
  name?: string;
}
