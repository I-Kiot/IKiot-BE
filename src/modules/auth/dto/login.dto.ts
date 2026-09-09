import { IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  phoneNumber: string;

  @IsString()
  @MinLength(1)
  password: string;
}
