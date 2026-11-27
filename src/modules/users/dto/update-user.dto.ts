import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';

/** Thông tin cá nhân của nhân viên. Trong Postgres lưu ở các cột `profile_*`. */
export class StaffProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxNumber?: string;

  /** Số CCCD, kiểm định dạng và khớp ngày sinh/giới tính trong service. */
  @IsOptional()
  @IsString()
  identificationId?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsIn(['MALE', 'FEMALE', 'OTHER'])
  gender?: string;
}

/** Body sửa nhân viên; mật khẩu, SĐT, trạng thái sửa qua route riêng. */
export class UpdateUserDto {
  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  /** Nơi làm việc; đặt một bên thì xoá bên kia. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  /** Xưởng người này làm việc; `null` để bỏ liên kết. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  workshopId?: string | null;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accountNote?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StaffProfileDto)
  profile?: StaffProfileDto;
}
