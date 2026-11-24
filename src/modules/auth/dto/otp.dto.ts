import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty({ message: 'Phiên xác minh không được để trống' })
  challengeToken: string;

  @IsString()
  @IsNotEmpty({ message: 'Mã OTP không được để trống' })
  otpCode: string;
}

export class ResendOtpDto {
  @IsString()
  @IsNotEmpty({ message: 'Phiên xác minh không được để trống' })
  challengeToken: string;
}

/** `identifier` là số điện thoại hoặc email; `phoneNumber` là tên trường cũ, vẫn nhận. */
export class ForgotPasswordDto {
  @IsOptional()
  @IsString()
  identifier?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;
}
