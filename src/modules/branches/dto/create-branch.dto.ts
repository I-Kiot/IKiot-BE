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

// Mirrors iKiotMS-BE's CreateBranchRequestDTO. `status` is deliberately absent - a new branch is always ACTIVE, and the generated DTO this replaces let a caller create one already soft-deleted.
export class CreateBranchDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên chi nhánh không được để trống' })
  name: string;

  // The Mongoose model validated "at least one phone number"; Postgres cannot express that on a text[], so it stays an app-layer rule.
  @IsArray()
  @ArrayNotEmpty({ message: 'Chi nhánh phải có ít nhất một số điện thoại' })
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
