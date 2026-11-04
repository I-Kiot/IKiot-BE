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

  /** CCCD Việt Nam. Định dạng và độ khớp với `dob`/`gender` được kiểm tra trong service; xem `validateVietnamIdentificationId` để biết vì sao ba trường phải khớp nhau. */
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

/** Các kiểm tra của `updateStaff`. `password`, `phoneNumber`, `status` đều bị từ chối: hai trường đầu có route riêng, còn vòng đời tài khoản chạy các guard mà ghi trường thường sẽ bỏ qua (nhận `status` là lỗ hổng của bản NestJS đầu). Không có `systemRole` để nhân viên không thể được thăng cấp qua endpoint này. */
export class UpdateUserDto {
  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsOptional()
  @IsUUID()
  roleId?: string;

  /** Nơi người này làm việc. Đặt một bên sẽ xoá bên kia: nhân viên chỉ thuộc đúng một địa điểm, service bắt buộc điều này thay vì tin client gửi đủ cả hai. */
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
