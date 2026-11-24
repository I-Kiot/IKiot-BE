import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';
import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'Refresh token không được để trống' })
  refreshToken: string;
}

/** Refresh token không bắt buộc (như controller cũ); userId luôn lấy từ access token, không từ body. */
export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({
    message: 'Mã xác thực đặt lại mật khẩu không được để trống',
  })
  token: string;

  // 6 ký tự là mức tối thiểu của service cũ; giữ đồng bộ với register và changePassword, vì lệch nhau là cách các chỗ này bị lệch.
  @IsString()
  @MinLength(6, { message: 'Mật khẩu mới phải có ít nhất 6 ký tự' })
  newPassword: string;
}

/** Mọi trường đều tuỳ chọn, để form kiểm tra trường nào người dùng vừa nhập xong. */
export class CheckAvailabilityDto {
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsOptional()
  @IsString()
  tenantName?: string;
}
