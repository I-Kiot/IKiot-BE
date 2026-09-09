import { IsOptional, IsString } from 'class-validator';

export class DeviceTokenDto {
  @IsString()
  token: string;

  @IsOptional()
  @IsString()
  userAgent?: string;
}
