import { IsOptional, IsString, MinLength } from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  tenantName: string;

  @IsString()
  @MinLength(8)
  phoneNumber: string;

  @IsString()
  @MinLength(6)
  password: string;

  // Bắt buộc và duy nhất toàn nền tảng; mã OTP xác minh gửi tới đây, sau đó nộp qua /auth/login/verify-otp.
  @NormalizeEmail()
  email: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}
