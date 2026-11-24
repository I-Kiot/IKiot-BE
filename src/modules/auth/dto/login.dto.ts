import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

/** `identifier` là số điện thoại hoặc email; `phoneNumber` là tên trường cũ (mobile web, script), vẫn nhận. */
export class LoginDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  identifier?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsString()
  @MinLength(1)
  password: string;
}
