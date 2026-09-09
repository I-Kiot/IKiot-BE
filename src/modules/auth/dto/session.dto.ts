import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

/** `POST /auth/refresh` - public, the token is the credential. */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'Refresh token không được để trống' })
  refreshToken: string;
}

/** `POST /auth/logout`. The refresh token is optional, as in the old controller - the user id always comes from the access token, never the body. */
export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

/** `POST /auth/verify-forgot-password-otp`. */
export class VerifyForgotPasswordOtpDto {
  @IsString()
  @IsNotEmpty({ message: 'Số điện thoại không được để trống' })
  phoneNumber: string;

  @IsString()
  @IsNotEmpty({ message: 'Mã OTP không được để trống' })
  otpCode: string;
}

/** `POST /auth/reset-password` - `token` is the one minted by the step above. */
export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty({
    message: 'Mã xác thực đặt lại mật khẩu không được để trống',
  })
  token: string;

  // 6, the old service's floor - kept in step with register and changePassword, since one of the three moving is how they drift apart.
  @IsString()
  @MinLength(6, { message: 'Mật khẩu mới phải có ít nhất 6 ký tự' })
  newPassword: string;
}

/** `POST /auth/check-availability` - both fields optional, so the form can ask about whichever one the user has just finished typing. */
export class CheckAvailabilityDto {
  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  tenantName?: string;
}
