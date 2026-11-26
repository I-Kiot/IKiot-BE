import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

/** Số điện thoại hoặc email; `phoneNumber` là tên trường cũ. */
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
