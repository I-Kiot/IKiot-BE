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

  // Được xác minh qua OtpService trước khi tạo tenant/owner; dev không có credential eSMS thì mã chỉ được log ra console.
  @IsString()
  otpCode: string;

  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}
