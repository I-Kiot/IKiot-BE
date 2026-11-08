import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { IsContactPhone } from '../../../common/decorators/contact-phone.decorator';

// Theo CreateBranchRequestDTO của iKiotMS-BE. Không có `status`: chi nhánh mới luôn ACTIVE (DTO generated cũ cho phép tạo sẵn ở trạng thái đã xoá).
export class CreateBranchDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên chi nhánh không được để trống' })
  name: string;

  // Model Mongoose kiểm "ít nhất một SĐT"; Postgres không diễn đạt được trên text[] nên giữ là luật tầng ứng dụng.
  @IsArray()
  @ArrayNotEmpty({ message: 'Chi nhánh phải có ít nhất một số điện thoại' })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @IsContactPhone({ each: true })
  phoneNumber: string[];

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  /** D-4: hàng hỏng / lỗi của chi nhánh này về đâu, một kho không bán được. `null` để xoá. */
  @IsOptional()
  @IsUUID('all', { message: 'damagedLocationId không hợp lệ' })
  damagedLocationId?: string | null;
}
