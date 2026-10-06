import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Ported from `validatePasswordCombo`. The "do the two match" rule is checked in the service rather than by a cross-field validator - one explicit comparison reads better, and the message is what the user sees. */
export class StaffAccountPasswordDto {
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  newPassword: string;

  @IsString()
  reEnterPassword: string;
}

/** Why an account was removed - kept on the row, since the row itself is anonymised. */
export class DeleteStaffDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deletionReason?: string;
}
