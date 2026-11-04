import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Port từ `validatePasswordCombo`. Kiểm tra hai mật khẩu khớp nhau nằm trong service, không phải validator liên trường: một phép so sánh rõ ràng dễ đọc hơn, và message là thứ người dùng thấy. */
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
