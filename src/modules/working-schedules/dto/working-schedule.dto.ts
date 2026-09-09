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

/** One row of the bulk assignment: these people, this shift, this day. */
export class ScheduleAssignmentDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Thiếu nhân viên' })
  @IsUUID('4', { each: true })
  // The old DTO accepted a bare id as well as an array; normalised here so the service only ever sees a list.
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

/** `POST /working-schedules/bulk`. */
export class BulkCreateWorkingScheduleDto {
  @IsArray({ message: 'Danh sách phân ca phải là một mảng' })
  @ArrayNotEmpty({ message: 'Cần ít nhất một bản ghi phân ca' })
  @ValidateNested({ each: true })
  @Type(() => ScheduleAssignmentDto)
  schedules: ScheduleAssignmentDto[];
}

/** `PATCH /working-schedules/:id`. One assignment's worth of fields, all required - the old endpoint ran the body through the bulk DTO and replaced every field, so a partial PATCH was never supported. */
export class UpdateWorkingScheduleDto extends ScheduleAssignmentDto {}

/** The filters every schedule list shares. */
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

  /** Inclusive; `endDate` covers the whole day, as the old range filter did. */
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

  // DELETED is absent on purpose: a soft-deleted schedule is not something a filter can ask for. The old service used the same three-value whitelist.
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
