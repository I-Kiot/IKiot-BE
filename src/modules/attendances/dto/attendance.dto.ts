import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  ATTENDANCE_STATUSES,
  MANUAL_ATTENDANCE_STATUSES,
} from '../attendance.constants';

const toBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );

/** Where the phone says it is. Every field required - a partial fix can't be judged. */
export class GeoPointDto {
  @Type(() => Number)
  @IsNumber({}, { message: 'Thiếu thông tin latitude(vĩ độ)' })
  @Min(-90, { message: 'Thông tin latitude(vĩ độ) không hợp lệ' })
  @Max(90, { message: 'Thông tin latitude(vĩ độ) không hợp lệ' })
  latitude: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'Thiếu thông tin longitude(kinh độ)' })
  @Min(-180, { message: 'Thông tin longitude(kinh độ) không hợp lệ' })
  @Max(180, { message: 'Thông tin longitude(kinh độ) không hợp lệ' })
  longitude: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'Thiếu thông tin accuracy(độ chính xác)' })
  @Min(0, { message: 'Thông tin accuracy(độ chính xác) không hợp lệ' })
  accuracy: number;
}

/** `POST /attendances/check-in`. Only the nested `checkInLocation` shape is accepted - the old DTO also took the coordinates flat. */
export class CheckInDto {
  @IsUUID(undefined, { message: 'Thiếu thông tin ca làm việc' })
  scheduleId: string;

  @IsDateString({}, { message: 'Thời gian check-in không hợp lệ' })
  actualCheckinAt: string;

  @ValidateNested()
  @Type(() => GeoPointDto)
  checkInLocation: GeoPointDto;
}

/** `POST /attendances/check-out`. */
export class CheckOutDto {
  @IsUUID(undefined, { message: 'Thiếu thông tin chấm công' })
  attendanceId: string;

  @IsDateString({}, { message: 'Thời gian check-out không hợp lệ' })
  actualCheckoutAt: string;

  @ValidateNested()
  @Type(() => GeoPointDto)
  checkOutLocation: GeoPointDto;
}

/** `PATCH /attendances/:id/manual-checkout` - a manager closing a shift somebody left open. */
export class ManualCheckoutDto {
  @IsDateString({}, { message: 'Giờ check-out không hợp lệ' })
  actualCheckoutAt: string;

  // A manual edit to a payroll input is always explained. The old DTO required it too.
  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'Lý do điều chỉnh là bắt buộc' })
  @MaxLength(500, { message: 'Lý do không được vượt quá 500 ký tự' })
  reason: string;
}

/** `POST /attendances/manual` - a manager writing the whole record after the fact. */
export class CreateManualAttendanceDto {
  @IsUUID()
  userId: string;

  @IsUUID()
  scheduleId: string;

  @IsIn(MANUAL_ATTENDANCE_STATUSES, {
    message: `status phải là ${MANUAL_ATTENDANCE_STATUSES.join(', ')}`,
  })
  status: string;

  /** Required unless the record is an ABSENT mark - checked in the service. */
  @IsOptional()
  @IsDateString({}, { message: 'Giờ check-in không hợp lệ' })
  actualCheckinAt?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Giờ check-out không hợp lệ' })
  actualCheckoutAt?: string;

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsNotEmpty({ message: 'Lý do là bắt buộc' })
  @MaxLength(500, { message: 'Lý do không được vượt quá 500 ký tự' })
  reason: string;
}

export class QueryAttendanceDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  scheduleId?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(ATTENDANCE_STATUSES, {
    message: `status phải là ${ATTENDANCE_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  checkinFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  checkinTo?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  checkoutFrom?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  checkoutTo?: string;

  /** Shifts clocked into and never closed - the ones a manager has to finish by hand. */
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  missingCheckout?: boolean;

  /** Only records where the person was late past the grace period; this works because check-in now stores `lateMinutes`, which iKiotMS-BE never wrote. */
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  lateOnly?: boolean;

  // `overtimeOnly` is deliberately absent: nothing ever wrote `Attendance.overtimeMinute`, and unlike lateness there is no definition to restore - extra hours are rostered as an OVERTIME schedule.
}
