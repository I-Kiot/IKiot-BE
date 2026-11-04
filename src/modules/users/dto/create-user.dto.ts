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

/** Tạo người ở trạng thái INACTIVE, chưa có mật khẩu: tuyển người và cấp login là hai việc tách nhau, cấp login qua `POST /users/:id/account`. Mọi trường của `UpdateUserDto` đều được nhận ở đây; bản NestJS đầu chỉ nhận 7 trường, nên CCCD, địa chỉ, hình thức lương bị `whitelist: true` bỏ im lặng mà vẫn trả 200. */
export class CreateUserDto {
  /** Định dạng được `validateVietnamPhoneNumber` kiểm tra trong service: đây là login và nơi nhận OTP nên phải là số nhận được SMS. */
  @IsString()
  phoneNumber: string;

  @IsOptional()
  @NormalizeEmail()
  email?: string;

  @IsUUID()
  roleId: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  /** Nhân viên xưởng: nhà cung cấp loại WORKSHOP mà người này làm việc. Họ thấy yêu cầu sản xuất của xưởng đó ở mọi địa điểm và ghi được phiếu giao (cần `production:deliver`). */
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

  /** Thông tin cá nhân, cùng object lồng như `PATCH /users/:id`. `firstName`/`lastName` cũng nhận dạng phẳng (như `StaffDTO` cũ); service ưu tiên cái nào được gửi. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StaffProfileDto)
  profile?: StaffProfileDto;
}
