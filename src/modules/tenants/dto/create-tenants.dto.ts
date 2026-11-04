import { IsOptional, IsString } from 'class-validator';

/** Admin-only. Banking is not here: `PUT /tenant/banking` and `PUT /tenant/:id/sepay-key` hold the rules for it. */
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
