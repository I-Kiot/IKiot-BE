import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  FILTERABLE_SCHEDULE_STATUSES,
  SCHEDULE_TYPES,
  ScheduleType,
} from '../working-schedule.constants';

export class ScheduleAssignmentDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Thiếu nhân viên' })
  @IsUUID('4', { each: true })
  // DTO cũ nhận cả id đơn lẻ; chuẩn hoá về mảng để service chỉ nhận một dạng.
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value : value === undefined ? value : [value],
  )
  userId: string[];

  @IsUUID(undefined, { message: 'Thiếu ca mẫu' })
  shiftTemplateId: string;

  @IsDateString(
    {},
    { message: 'Ngày làm việc không hợp lệ, hãy nhập YYYY-MM-DD' },
  )
  workDate: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(SCHEDULE_TYPES, { message: 'Loại lịch làm việc không hợp lệ' })
  scheduleType?: string = ScheduleType.NORMAL;
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

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(SCHEDULE_TYPES, { message: 'Loại lịch làm việc không hợp lệ' })
  scheduleType?: string;
}
