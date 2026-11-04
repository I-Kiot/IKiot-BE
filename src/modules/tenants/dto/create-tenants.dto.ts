import { IsOptional, IsString } from 'class-validator';

/** Chỉ admin. Phần ngân hàng không nằm ở đây: `PUT /tenant/banking` và `PUT /tenant/:id/sepay-key` giữ quy tắc của nó. */
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
