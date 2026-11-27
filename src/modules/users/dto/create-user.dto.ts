import { Type } from 'class-transformer';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { NormalizeEmail } from '../../../common/decorators/normalize-email.decorator';
import { StaffProfileDto } from './update-user.dto';

/** Body tuyển nhân viên, tạo ở trạng thái INACTIVE chưa có mật khẩu. */
export class CreateUserDto {
  /** Số điện thoại đăng nhập, kiểm trong service. */
  @IsString()
  phoneNumber: string;

  /** Bắt buộc, duy nhất toàn nền tảng: OTP đăng nhập lần đầu gửi tới đây. */
  @NormalizeEmail()
  email: string;

  @IsUUID()
  roleId: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  /** Xưởng mà nhân viên làm việc; `production:deliver` tự cấp khi gắn xưởng. */
  @IsOptional()
  @IsUUID()
  workshopId?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsDateString()
  hireDate?: string;

  /** Thông tin cá nhân. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StaffProfileDto)
  profile?: StaffProfileDto;
}
