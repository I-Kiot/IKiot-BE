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

  // Email bắt buộc và duy nhất, nhận mã OTP xác minh.
  @NormalizeEmail()
  email: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}
