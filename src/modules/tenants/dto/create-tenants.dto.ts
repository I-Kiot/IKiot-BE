import { IsOptional, IsString } from 'class-validator';

/** Body tạo tenant, chỉ admin. */
export class CreateTenantDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  tenantOwnerId?: string;

  @IsString()
  status: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  mainAddress?: string;

  @IsOptional()
  @IsString()
  taxNumber?: string;
}
