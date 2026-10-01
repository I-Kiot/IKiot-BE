import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';
import {
  LEAVE_REQUEST_STATUSES,
  REVIEW_DECISIONS,
} from '../leave-request.constants';

const trim = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );

/** `POST /leave-requests` - filing your own leave. */
export class CreateLeaveRequestDto {
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  startDate: string;

  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  endDate: string;

  @IsString()
  @trim()
  @IsNotEmpty({ message: 'Lý do nghỉ phép là bắt buộc' })
  @MaxLength(500)
  reason: string;

  /** Only meaningful when the requester manages shifts inside the leave window; the service refuses it otherwise, since handing over shifts you don't run means nothing. */
  @IsOptional()
  @IsUUID()
  handoverToUserId?: string;
}

/** `POST /leave-requests/emergency` - a manager filing on behalf of somebody who couldn't file it themselves. */
export class CreateEmergencyLeaveRequestDto extends CreateLeaveRequestDto {
  @IsUUID(undefined, { message: 'Mã nhân viên không hợp lệ' })
  userId: string;
}

/** `POST /leave-requests/:id/approve` and `/reject`. The day counts are required on approval and ignored on rejection (only the service knows which route was taken), and a rejection must carry a `reviewNote`. */
export class ReviewLeaveRequestDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số ngày nghỉ có lương không được âm' })
  paidLeaveDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0, { message: 'Số ngày nghỉ không lương không được âm' })
  unpaidLeaveDays?: number;

  @IsOptional()
  @IsString()
  @trim()
  @MaxLength(500)
  reviewNote?: string;
}

/** `POST /leave-requests/handover/preview` - which shifts a leave window would strand. */
export class PreviewHandoverDto {
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  startDate: string;

  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  endDate: string;
}

export class QueryLeaveRequestDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

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
  @IsIn(LEAVE_REQUEST_STATUSES, {
    message: 'Trạng thái yêu cầu nghỉ phép không hợp lệ',
  })
  status?: string;

  /** Matches the reason, or the requester's name. */
  @IsOptional()
  @IsString()
  @trim()
  keyword?: string;

  /** Filters on `startDate` - "leave beginning in this window", as the old filter did. */
  @IsOptional()
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  endDate?: string;
}

/** `GET /leave-requests/me/per-day` - one row per calendar day, for a calendar view. */
export class QueryLeavePerDayDto {
  @IsOptional()
  @IsDateString({}, { message: 'Ngày bắt đầu không hợp lệ' })
  startDate?: string;

  @IsOptional()
  @IsDateString({}, { message: 'Ngày kết thúc không hợp lệ' })
  endDate?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: string;
}

/** Not a request body - the decision is in the route, this documents the pair. */
export const REVIEW_DECISION_VALUES = REVIEW_DECISIONS;
