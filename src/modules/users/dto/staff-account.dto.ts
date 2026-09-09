import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Ported from `validatePasswordCombo`. The "do the two match" rule is checked in the service rather than by a cross-field validator - one explicit comparison reads better, and the message is what the user sees. */
export class StaffAccountPasswordDto {
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  newPassword: string;

  @IsString()
  reEnterPassword: string;
}

/** Ported from UpdateAnnualLeaveDaysDTO. The upper bound is new: the old DTO accepted any non-negative integer, so a typo could hand somebody 3650 days of leave. */
export class LeaveBalanceDto {
  @Type(() => Number)
  @IsInt({ message: 'Số ngày phép năm phải là số nguyên' })
  @Min(0, { message: 'Số ngày phép năm không được âm' })
  @Max(365, { message: 'Số ngày phép năm không được vượt quá 365' })
  annualLeaveDays: number;
}

/** Why an account was removed - kept on the row, since the row itself is anonymised. */
export class DeleteStaffDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deletionReason?: string;
}
