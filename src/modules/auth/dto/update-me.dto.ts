import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';

// Quyền sửa từng trường kiểm trong `AuthService.updateMe`.
export class UpdateMeDto {
  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  taxNumber?: string;

  @IsOptional()
  @IsString()
  identificationId?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;
}
