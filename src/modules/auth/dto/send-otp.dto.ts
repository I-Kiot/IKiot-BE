import { IsString, MinLength } from 'class-validator';

export class SendOtpDto {
  @IsString()
  @MinLength(8)
  phoneNumber: string;
}
