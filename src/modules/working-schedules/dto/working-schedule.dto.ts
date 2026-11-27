import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import { FILTERABLE_SCHEDULE_STATUSES } from '../working-schedule.constants';

// DTO cũ nhận cả id đơn lẻ; chuẩn hoá về mảng để service chỉ nhận một dạng.
const toArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value : value === undefined ? value : [value];

export class ScheduleAssignmentDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Thiếu nhân viên' })
  @IsUUID('4', { each: true })
  @Transform(toArray)
  userId: string[];

  @IsUUID(undefined, { message: 'Thiếu ca mẫu' })
  shiftTemplateId: string;

  @IsDateString(
    {},
    { message: 'Ngày làm việc không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  workDate: string;
}

export class BulkCreateWorkingScheduleDto {
  @IsArray({ message: 'Danh sách phân ca phải là một mảng' })
  @ArrayNotEmpty({ message: 'Cần ít nhất một bản ghi phân ca' })
  @ValidateNested({ each: true })
  @Type(() => ScheduleAssignmentDto)
  schedules: ScheduleAssignmentDto[];
}

/** PATCH thay toàn bộ các trường (như route cũ), nên không hỗ trợ PATCH từng phần. */
export class UpdateWorkingScheduleDto extends ScheduleAssignmentDto {}

/** Lịch lặp lại: (các) nhân viên giữ một ca mẫu từ ngày đến ngày, vào các thứ đã chọn. */
export class CreateScheduleSeriesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Thiếu nhân viên' })
  @IsUUID('4', { each: true })
  @Transform(toArray)
  userId: string[];

  @IsUUID(undefined, { message: 'Thiếu ca mẫu' })
  shiftTemplateId: string;

  @IsDateString(
    {},
    { message: 'Ngày bắt đầu không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  startDate: string;

  @IsDateString(
    {},
    { message: 'Ngày kết thúc không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  endDate: string;

  @ApiPropertyOptional({
    description:
      'Thứ trong tuần được làm: 0 = Chủ nhật … 6 = Thứ bảy. Bỏ trống = mọi ngày.',
    example: [1, 2, 3, 4, 5, 6],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true, message: 'Thứ trong tuần không hợp lệ' })
  @Min(0, { each: true, message: 'Thứ trong tuần không hợp lệ' })
  @Max(6, { each: true, message: 'Thứ trong tuần không hợp lệ' })
  weekdays?: number[];
}

export class RemoveScheduleSeriesQueryDto {
  @ApiPropertyOptional({
    description:
      'Gỡ các ca của lịch lặp từ ngày này trở đi (YYYY-MM-DD). Bỏ trống = hôm nay. Ca đã qua giữ nguyên.',
  })
  @IsOptional()
  @IsDateString({}, { message: 'Ngày không hợp lệ, hãy nhập YYYY-MM-DD' })
  fromDate?: string;
}

export class QueryWorkingScheduleDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  /** Bao gồm cả hai đầu; `endDate` tính đủ cả ngày, như bộ lọc khoảng cũ. */
  @IsOptional()
  @IsDateString(
    {},
    { message: 'Ngày bắt đầu không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  startDate?: string;

  @IsOptional()
  @IsDateString(
    {},
    { message: 'Ngày kết thúc không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  endDate?: string;

  // Cố ý không có DELETED: lịch đã xoá mềm không được lọc ra. Whitelist cũ cũng chỉ có ba giá trị.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(FILTERABLE_SCHEDULE_STATUSES, {
    message: 'Trạng thái lịch làm việc không hợp lệ',
  })
  status?: string;
}
