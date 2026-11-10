import { IsString, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;

  /** Ô "nhập lại mật khẩu"; khớp với `newPassword` được kiểm tra trong service. */
  @IsString()
  reEnterPassword: string;
}
