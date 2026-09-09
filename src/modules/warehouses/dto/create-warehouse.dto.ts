import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { AttendanceLocationDto } from '../../../common/dto/attendance-location.dto';

// Mirrors CreateBranchDto: a tenant now runs several warehouses, so one carries the same contact details and validation rules a branch does - `phoneNumber` and `email` are new since the 2026-08-19 migration.
export class CreateWarehouseDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên kho không được để trống' })
  name: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'Kho phải có ít nhất một số điện thoại' })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  phoneNumber: string[];

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsEmail({}, { message: 'Email không hợp lệ' })
  email?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AttendanceLocationDto)
  attendanceTakingLocation?: AttendanceLocationDto;
}
