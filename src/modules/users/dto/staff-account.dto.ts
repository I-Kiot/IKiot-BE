import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Body đặt mật khẩu, kiểm khớp trong service. */
export class StaffAccountPasswordDto {
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  newPassword: string;

  @IsString()
  reEnterPassword: string;
}

/** Lý do xoá tài khoản; lưu trên row vì row đã bị ẩn danh. */
export class DeleteStaffDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  deletionReason?: string;
}
