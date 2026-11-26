import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { IsContactPhone } from '../../../common/decorators/contact-phone.decorator';

// Giống CreateBranchDto: tenant giờ có nhiều kho nên cùng thông tin liên hệ và luật kiểm như chi nhánh (`phoneNumber`, `email` mới từ migration 2026-08-19).
export class CreateWarehouseDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  name: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Kho phải có ít nhất một số điện thoại' })
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
