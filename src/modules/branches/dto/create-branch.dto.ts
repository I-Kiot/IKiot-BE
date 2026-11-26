import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsContactPhone } from '../../../common/decorators/contact-phone.decorator';

// Body tạo chi nhánh, luôn ACTIVE.
export class CreateBranchDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên chi nhánh không được để trống' })
  name: string;

  // Bắt buộc ít nhất một SĐT.
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
}
